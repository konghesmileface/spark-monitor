"""Auth API — register, login, logout, me, status, forgot-password, reset-password.

Blueprint prefix: /api/auth
"""

import json
import logging
import random
import re
import uuid
from datetime import datetime, timedelta

import pymysql
from flask import Blueprint, g, jsonify, request

from services.auth_service import (
    _get_db,
    create_session,
    hash_password,
    require_auth,
    verify_password,
)

logger = logging.getLogger('cn-intel.auth-api')

auth_bp = Blueprint('auth', __name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')


def _validate_email(email: str) -> bool:
    return bool(_EMAIL_RE.match(email))


def _resolve_profile_user_id(conn, account: dict) -> str | None:
    """Look up or create a user_profiles record for the account.

    Returns the profile's user_id (UUID) so the frontend can set it
    in localStorage as cn_user_profile_id, bridging the auth system
    and the profile system.
    """
    profile_id = account.get('profile_id')
    account_id = account['id']

    try:
        # If account has a linked profile, look up its UUID
        # and backfill locked fields (company_name, company_size) from wm_accounts
        if profile_id:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT user_id, company_name, company_size FROM user_profiles WHERE id = %s",
                    (profile_id,),
                )
                row = cur.fetchone()
                if row:
                    # Backfill locked fields if empty in profile but present in account
                    p_name = (row.get('company_name') or '').strip()
                    p_size = (row.get('company_size') or '').strip()
                    a_name = (account.get('company_name') or '').strip()
                    a_size = (account.get('company_size') or '').strip()
                    if (not p_name and a_name) or (not p_size and a_size):
                        with conn.cursor() as cur2:
                            cur2.execute(
                                "UPDATE user_profiles SET company_name = %s, company_size = %s "
                                "WHERE id = %s",
                                (a_name or p_name, a_size or p_size, profile_id),
                            )
                        conn.commit()
                        logger.warning(f'[auth] Backfilled locked fields for profile {row["user_id"]}')
                    return row['user_id']

        # No linked profile found — auto-create from account registration data
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT company_name, company_size, business_scope, industries, "
                "       competitors, supply_chain_up, supply_chain_down "
                "FROM wm_accounts WHERE id = %s",
                (account_id,),
            )
            acct_data = cur.fetchone()

        if not acct_data:
            return None

        profile_uid = str(uuid.uuid4())

        # Parse JSON-or-CSV text fields from wm_accounts
        def _parse_json_or_csv(raw):
            if not raw:
                return []
            try:
                val = json.loads(raw)
                if isinstance(val, list):
                    return val
            except (json.JSONDecodeError, TypeError):
                pass
            return [s.strip() for s in raw.split(',') if s.strip()]

        industries_list = _parse_json_or_csv(acct_data.get('industries'))
        competitors_list = _parse_json_or_csv(acct_data.get('competitors'))
        supply_up_list = _parse_json_or_csv(acct_data.get('supply_chain_up'))
        supply_down_list = _parse_json_or_csv(acct_data.get('supply_chain_down'))

        from services.user_profile import upsert_profile
        profile_data = {
            'company_name': acct_data.get('company_name') or '',
            'company_size': acct_data.get('company_size') or '',
            'business_scope': acct_data.get('business_scope') or '',
            'industries': industries_list,
            'competitors': competitors_list,
            'supply_chain_up': supply_up_list,
            'supply_chain_down': supply_down_list,
        }
        profile = upsert_profile(profile_uid, profile_data)

        if profile:
            # Link back to wm_accounts
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT id FROM user_profiles WHERE user_id = %s",
                    (profile_uid,),
                )
                prow = cur.fetchone()
                if prow:
                    with conn.cursor() as cur2:
                        cur2.execute(
                            "UPDATE wm_accounts SET profile_id = %s WHERE id = %s",
                            (prow['id'], account_id),
                        )
            conn.commit()
            logger.warning(f'[auth] Auto-created profile {profile_uid} for account {account_id}')
            return profile_uid

    except Exception as e:
        logger.warning(f'[auth] Profile resolution error (non-blocking): {e}')

    return None


# ---------------------------------------------------------------------------
# POST /api/auth/register
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/register', methods=['POST'])
def register():
    """Register a new account (status='pending', awaiting admin approval)."""
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = (data.get('password') or '').strip()

    if not email or not password:
        return jsonify({'error': 'email and password are required'}), 400
    if not _validate_email(email):
        return jsonify({'error': 'Invalid email format'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    company_name = (data.get('company_name') or '').strip()
    contact_name = (data.get('contact_name') or '').strip()
    contact_phone = (data.get('contact_phone') or '').strip()
    company_size = (data.get('company_size') or '').strip()
    business_scope = (data.get('business_scope') or '').strip()
    industries_raw = data.get('industries') or ''
    if isinstance(industries_raw, list):
        industries = json.dumps(industries_raw, ensure_ascii=False)
    else:
        industries = str(industries_raw).strip()

    # New fields: competitors / supply chain
    competitors_raw = data.get('competitors') or ''
    if isinstance(competitors_raw, list):
        competitors = json.dumps(competitors_raw, ensure_ascii=False)
    else:
        competitors = str(competitors_raw).strip()

    supply_chain_up_raw = data.get('supply_chain_up') or ''
    if isinstance(supply_chain_up_raw, list):
        supply_chain_up = json.dumps(supply_chain_up_raw, ensure_ascii=False)
    else:
        supply_chain_up = str(supply_chain_up_raw).strip()

    supply_chain_down_raw = data.get('supply_chain_down') or ''
    if isinstance(supply_chain_down_raw, list):
        supply_chain_down = json.dumps(supply_chain_down_raw, ensure_ascii=False)
    else:
        supply_chain_down = str(supply_chain_down_raw).strip()

    pw_hash = hash_password(password)

    conn = _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM wm_accounts WHERE email = %s", (email,))
            if cur.fetchone():
                return jsonify({'error': 'Email already registered'}), 409

            cur.execute(
                "INSERT INTO wm_accounts "
                "(email, password_hash, company_name, contact_name, contact_phone, "
                " company_size, business_scope, industries, "
                " competitors, supply_chain_up, supply_chain_down) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (email, pw_hash, company_name, contact_name, contact_phone,
                 company_size, business_scope, industries,
                 competitors, supply_chain_up, supply_chain_down),
            )
        conn.commit()
        logger.warning(f'[auth] New registration: {email} (company={company_name})')
        return jsonify({
            'ok': True,
            'message': 'Registration submitted. Awaiting admin approval.',
            'email': email,
        }), 201
    except Exception as e:
        logger.warning(f'[auth] Register error: {e}')
        return jsonify({'error': 'Registration failed'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/auth/login
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/login', methods=['POST'])
def login():
    """Authenticate with email + password. Returns session token if approved."""
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = (data.get('password') or '').strip()

    if not email or not password:
        return jsonify({'error': 'email and password are required'}), 400

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, password_hash, role, status, "
                "       company_name, company_size, contact_name, profile_id "
                "FROM wm_accounts WHERE email = %s",
                (email,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'Invalid email or password'}), 401

        if not verify_password(password, account['password_hash']):
            return jsonify({'error': 'Invalid email or password'}), 401

        # Check account status
        if account['status'] == 'pending':
            return jsonify({'error': 'Account pending approval', 'status': 'pending'}), 403
        if account['status'] == 'rejected':
            return jsonify({'error': 'Account application rejected', 'status': 'rejected'}), 403
        if account['status'] == 'suspended':
            return jsonify({'error': 'Account suspended', 'status': 'suspended'}), 403

        # Create session
        token = create_session(account['id'], db_conn=conn)

        # Update last_login_at
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET last_login_at = %s WHERE id = %s",
                (datetime.now(), account['id']),
            )
        conn.commit()

        # Resolve profile_user_id (UUID used by cn-profile frontend)
        profile_user_id = _resolve_profile_user_id(conn, account)

        logger.warning(f'[auth] Login: {email} (role={account["role"]}, profile_uid={profile_user_id})')
        return jsonify({
            'ok': True,
            'token': token,
            'user': {
                'id': account['id'],
                'email': account['email'],
                'role': account['role'],
                'status': account['status'],
                'company_name': account['company_name'],
                'contact_name': account['contact_name'],
                'profile_id': account['profile_id'],
            },
            'profile_user_id': profile_user_id,
        })
    except Exception as e:
        logger.warning(f'[auth] Login error: {e}')
        return jsonify({'error': 'Login failed'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/auth/logout
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/logout', methods=['POST'])
@require_auth
def logout():
    """Delete the current session token."""
    auth_header = request.headers.get('Authorization', '')
    token = auth_header[7:].strip()

    conn = _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM wm_sessions WHERE token = %s", (token,))
        conn.commit()
        logger.warning(f'[auth] Logout: {g.current_user["email"]}')
        return jsonify({'ok': True, 'message': 'Logged out'})
    except Exception as e:
        logger.warning(f'[auth] Logout error: {e}')
        return jsonify({'error': 'Logout failed'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/auth/me
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/me')
@require_auth
def me():
    """Return current authenticated user info."""
    return jsonify({
        'ok': True,
        'user': g.current_user,
    })


# ---------------------------------------------------------------------------
# GET /api/auth/status?email=...
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/status')
def application_status():
    """Check application status by email (no auth required)."""
    email = (request.args.get('email') or '').strip().lower()
    if not email:
        return jsonify({'error': 'email parameter required'}), 400

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT status, applied_at, reviewed_at, review_note "
                "FROM wm_accounts WHERE email = %s",
                (email,),
            )
            row = cur.fetchone()

        if not row:
            return jsonify({'error': 'Email not found'}), 404

        return jsonify({
            'email': email,
            'status': row['status'],
            'applied_at': row['applied_at'].isoformat() if row['applied_at'] else None,
            'reviewed_at': row['reviewed_at'].isoformat() if row['reviewed_at'] else None,
            'review_note': row['review_note'],
        })
    except Exception as e:
        logger.warning(f'[auth] Status check error: {e}')
        return jsonify({'error': 'Failed to check status'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/auth/forgot-password
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/forgot-password', methods=['POST'])
def forgot_password():
    """Send a 6-digit verification code to the registered email."""
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()

    if not email or not _validate_email(email):
        return jsonify({'error': '请输入有效的邮箱地址'}), 400

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, status FROM wm_accounts WHERE email = %s",
                (email,),
            )
            account = cur.fetchone()

        if not account:
            # Don't reveal whether the email exists
            return jsonify({'ok': True, 'message': '如果该邮箱已注册，验证码将发送至您的邮箱'})

        if account['status'] != 'approved':
            return jsonify({'error': '该账户尚未通过审核'}), 403

        account_id = account['id']

        # Rate limit: 60s between requests
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT created_at FROM wm_password_resets "
                "WHERE account_id = %s ORDER BY created_at DESC LIMIT 1",
                (account_id,),
            )
            last = cur.fetchone()

        if last and last['created_at']:
            elapsed = (datetime.now() - last['created_at']).total_seconds()
            if elapsed < 60:
                return jsonify({'error': f'请 {int(60 - elapsed)} 秒后再试'}), 429

        # Generate 6-digit code
        code = f'{random.randint(0, 999999):06d}'
        expires_at = datetime.now() + timedelta(minutes=15)

        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO wm_password_resets (account_id, code, expires_at) "
                "VALUES (%s, %s, %s)",
                (account_id, code, expires_at),
            )
        conn.commit()

        # Send email
        from services.email_service import send_reset_code
        sent = send_reset_code(email, code)
        if not sent:
            logger.warning(f'[auth] Reset code email failed for {email}')
            return jsonify({'error': '邮件发送失败，请稍后重试'}), 500

        logger.warning(f'[auth] Reset code sent to {email}')
        return jsonify({'ok': True, 'message': '验证码已发送至您的邮箱'})
    except Exception as e:
        logger.warning(f'[auth] Forgot password error: {e}')
        return jsonify({'error': '操作失败，请稍后重试'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/auth/reset-password
# ---------------------------------------------------------------------------

@auth_bp.route('/api/auth/reset-password', methods=['POST'])
def reset_password():
    """Verify code and reset password."""
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    code = (data.get('code') or '').strip()
    new_password = (data.get('new_password') or '').strip()

    if not email or not code or not new_password:
        return jsonify({'error': '请填写所有必填字段'}), 400
    if len(new_password) < 6:
        return jsonify({'error': '新密码至少 6 个字符'}), 400

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id FROM wm_accounts WHERE email = %s AND status = 'approved'",
                (email,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': '邮箱未注册或未通过审核'}), 400

        account_id = account['id']

        # Find valid, unused code
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, expires_at FROM wm_password_resets "
                "WHERE account_id = %s AND code = %s AND used_at IS NULL "
                "ORDER BY created_at DESC LIMIT 1",
                (account_id, code),
            )
            reset_row = cur.fetchone()

        if not reset_row:
            return jsonify({'error': '验证码无效'}), 400

        if reset_row['expires_at'] < datetime.now():
            return jsonify({'error': '验证码已过期，请重新获取'}), 400

        # Update password + mark code as used
        new_hash = hash_password(new_password)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET password_hash = %s WHERE id = %s",
                (new_hash, account_id),
            )
            cur.execute(
                "UPDATE wm_password_resets SET used_at = %s WHERE id = %s",
                (datetime.now(), reset_row['id']),
            )
        conn.commit()

        logger.warning(f'[auth] Password reset successful for {email}')
        return jsonify({'ok': True, 'message': '密码重置成功，请使用新密码登录'})
    except Exception as e:
        logger.warning(f'[auth] Reset password error: {e}')
        return jsonify({'error': '密码重置失败'}), 500
    finally:
        conn.close()
