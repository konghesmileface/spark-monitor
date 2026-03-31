"""Admin API — application review, user management, subscription management.

Blueprint prefix: /api/admin
All endpoints require admin authentication.
"""

import json
import logging
import uuid
from datetime import datetime, timedelta

import pymysql
from flask import Blueprint, g, jsonify, request

from services.auth_service import _get_db, hash_password, require_admin

logger = logging.getLogger('cn-intel.admin-api')

admin_bp = Blueprint('admin', __name__)


# ---------------------------------------------------------------------------
# GET /api/admin/applications — list pending applications
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/applications')
@require_admin
def list_applications():
    """List pending account applications."""
    status_filter = request.args.get('status', 'pending')
    limit = min(int(request.args.get('limit', '50')), 200)
    offset = int(request.args.get('offset', '0'))

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, status, company_name, contact_name, contact_phone, "
                "       company_size, business_scope, industries, "
                "       competitors, supply_chain_up, supply_chain_down, "
                "       applied_at, reviewed_at, reviewed_by, review_note "
                "FROM wm_accounts "
                "WHERE status = %s "
                "ORDER BY applied_at DESC "
                "LIMIT %s OFFSET %s",
                (status_filter, limit, offset),
            )
            rows = cur.fetchall()

            # Get total count
            cur.execute(
                "SELECT COUNT(*) as cnt FROM wm_accounts WHERE status = %s",
                (status_filter,),
            )
            total = cur.fetchone()['cnt']

        # Serialize datetimes
        for row in rows:
            for key in ('applied_at', 'reviewed_at'):
                if row.get(key) and isinstance(row[key], datetime):
                    row[key] = row[key].isoformat()

        return jsonify({
            'ok': True,
            'applications': rows,
            'total': total,
            'limit': limit,
            'offset': offset,
        })
    except Exception as e:
        logger.warning(f'[admin] List applications error: {e}')
        return jsonify({'error': 'Failed to list applications'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/admin/applications/<id>/approve
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/applications/<int:app_id>/approve', methods=['POST'])
@require_admin
def approve_application(app_id):
    """Approve a pending application and create a user_profiles record."""
    data = request.get_json(silent=True) or {}
    review_note = (data.get('review_note') or '').strip()

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            # Fetch the account
            cur.execute(
                "SELECT id, email, status, company_name, company_size, "
                "       business_scope, industries, "
                "       competitors, supply_chain_up, supply_chain_down "
                "FROM wm_accounts WHERE id = %s",
                (app_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'Application not found'}), 404

        if account['status'] != 'pending':
            return jsonify({
                'error': f'Application already {account["status"]}',
                'status': account['status'],
            }), 409

        admin_id = g.current_user['id']
        now = datetime.now()

        # Create a user_profiles record via the existing service
        profile_user_id = str(uuid.uuid4())
        try:
            from services.user_profile import upsert_profile

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

            profile_data = {
                'company_name': account.get('company_name') or '',
                'company_size': account.get('company_size') or '',
                'business_scope': account.get('business_scope') or '',
                'industries': _parse_json_or_csv(account.get('industries')),
                'competitors': _parse_json_or_csv(account.get('competitors')),
                'supply_chain_up': _parse_json_or_csv(account.get('supply_chain_up')),
                'supply_chain_down': _parse_json_or_csv(account.get('supply_chain_down')),
            }
            profile = upsert_profile(profile_user_id, profile_data)
            logger.warning(f'[admin] Created user_profile {profile_user_id} for account {app_id}')
        except Exception as e:
            logger.warning(f'[admin] Profile creation failed (non-blocking): {e}')
            profile = None

        # Approve the account and link profile_id
        # Retrieve the profile DB id if created
        profile_db_id = None
        if profile:
            try:
                with conn.cursor(pymysql.cursors.DictCursor) as cur:
                    cur.execute(
                        "SELECT id FROM user_profiles WHERE user_id = %s",
                        (profile_user_id,),
                    )
                    prow = cur.fetchone()
                    if prow:
                        profile_db_id = prow['id']
            except Exception:
                pass

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET status = 'approved', reviewed_at = %s, "
                "       reviewed_by = %s, review_note = %s, profile_id = %s "
                "WHERE id = %s",
                (now, admin_id, review_note, profile_db_id, app_id),
            )
        conn.commit()

        logger.warning(f'[admin] Approved account {app_id} ({account["email"]}) by admin {admin_id}')

        # Send approval notification email (non-blocking)
        try:
            from services.email_service import send_account_approved
            send_account_approved(
                to_email=account['email'],
                contact_name=account.get('company_name', ''),
                company_name=account.get('company_name', ''),
            )
        except Exception as e:
            logger.warning(f'[admin] Approval email failed (non-blocking): {e}')

        return jsonify({
            'ok': True,
            'message': 'Application approved',
            'account_id': app_id,
            'profile_user_id': profile_user_id,
        })
    except Exception as e:
        logger.warning(f'[admin] Approve error: {e}')
        return jsonify({'error': 'Failed to approve application'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/admin/applications/<id>/reject
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/applications/<int:app_id>/reject', methods=['POST'])
@require_admin
def reject_application(app_id):
    """Reject a pending application with an optional note."""
    data = request.get_json(silent=True) or {}
    review_note = (data.get('review_note') or '').strip()

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, status FROM wm_accounts WHERE id = %s",
                (app_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'Application not found'}), 404

        if account['status'] != 'pending':
            return jsonify({
                'error': f'Application already {account["status"]}',
                'status': account['status'],
            }), 409

        admin_id = g.current_user['id']
        now = datetime.now()

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET status = 'rejected', reviewed_at = %s, "
                "       reviewed_by = %s, review_note = %s "
                "WHERE id = %s",
                (now, admin_id, review_note, app_id),
            )
        conn.commit()

        logger.warning(f'[admin] Rejected account {app_id} ({account["email"]}) by admin {admin_id}')
        return jsonify({
            'ok': True,
            'message': 'Application rejected',
            'account_id': app_id,
        })
    except Exception as e:
        logger.warning(f'[admin] Reject error: {e}')
        return jsonify({'error': 'Failed to reject application'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/admin/users — list approved users
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users')
@require_admin
def list_users():
    """List approved and suspended users."""
    limit = min(int(request.args.get('limit', '50')), 200)
    offset = int(request.args.get('offset', '0'))

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, role, status, company_name, contact_name, "
                "       contact_phone, company_size, business_scope, industries, "
                "       competitors, supply_chain_up, supply_chain_down, "
                "       profile_id, expires_at, last_login_at, created_at "
                "FROM wm_accounts "
                "WHERE status IN ('approved', 'suspended') AND role != 'admin' "
                "ORDER BY created_at DESC "
                "LIMIT %s OFFSET %s",
                (limit, offset),
            )
            rows = cur.fetchall()

            cur.execute(
                "SELECT COUNT(*) as cnt FROM wm_accounts "
                "WHERE status IN ('approved', 'suspended') AND role != 'admin'",
            )
            total = cur.fetchone()['cnt']

        # Serialize datetimes
        for row in rows:
            for key in ('last_login_at', 'created_at', 'expires_at'):
                if row.get(key) and isinstance(row[key], datetime):
                    row[key] = row[key].isoformat()

        return jsonify({
            'ok': True,
            'users': rows,
            'total': total,
            'limit': limit,
            'offset': offset,
        })
    except Exception as e:
        logger.warning(f'[admin] List users error: {e}')
        return jsonify({'error': 'Failed to list users'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/admin/users/<id>/suspend
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users/<int:user_id>/suspend', methods=['POST'])
@require_admin
def suspend_user(user_id):
    """Suspend an approved user. Also invalidates all their sessions."""
    data = request.get_json(silent=True) or {}
    review_note = (data.get('review_note') or '').strip()

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, status, role FROM wm_accounts WHERE id = %s",
                (user_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'User not found'}), 404

        if account['role'] == 'admin':
            return jsonify({'error': 'Cannot suspend admin accounts'}), 403

        if account['status'] == 'suspended':
            return jsonify({'error': 'User already suspended'}), 409

        admin_id = g.current_user['id']
        now = datetime.now()

        with conn.cursor() as cur:
            # Suspend account
            cur.execute(
                "UPDATE wm_accounts SET status = 'suspended', reviewed_at = %s, "
                "       reviewed_by = %s, review_note = %s "
                "WHERE id = %s",
                (now, admin_id, review_note, user_id),
            )
            # Invalidate all sessions
            cur.execute(
                "DELETE FROM wm_sessions WHERE account_id = %s",
                (user_id,),
            )
        conn.commit()

        logger.warning(f'[admin] Suspended user {user_id} ({account["email"]}) by admin {admin_id}')
        return jsonify({
            'ok': True,
            'message': 'User suspended',
            'user_id': user_id,
        })
    except Exception as e:
        logger.warning(f'[admin] Suspend error: {e}')
        return jsonify({'error': 'Failed to suspend user'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/admin/accounts — admin creates an account directly (approved)
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/accounts', methods=['POST'])
@require_admin
def create_account():
    """Admin creates a new account directly with status='approved'."""
    import re

    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = (data.get('password') or '').strip()
    contact_name = (data.get('contact_name') or '').strip()
    contact_phone = (data.get('contact_phone') or '').strip()
    company_name = (data.get('company_name') or '').strip()
    company_size = (data.get('company_size') or '').strip()
    business_scope = (data.get('business_scope') or '').strip()

    # Subscription expiry
    expires_at_str = (data.get('expires_at') or '').strip()
    expires_at = None
    if expires_at_str:
        try:
            expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00')).replace(tzinfo=None)
        except ValueError:
            try:
                expires_at = datetime.strptime(expires_at_str, '%Y-%m-%d')
            except ValueError:
                return jsonify({'error': 'expires_at format invalid (use YYYY-MM-DD)'}), 400

    # Profile enrichment fields
    industries = data.get('industries') or []
    competitors = data.get('competitors') or []
    supply_chain_up = data.get('supply_chain_up') or []
    supply_chain_down = data.get('supply_chain_down') or []

    # Serialize industries for wm_accounts column
    if isinstance(industries, list):
        industries_str = json.dumps(industries, ensure_ascii=False)
    else:
        industries_str = str(industries).strip()

    # Validation
    if not email or not password or not contact_name or not company_name:
        return jsonify({'error': 'email, password, contact_name, company_name are required'}), 400

    email_re = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
    if not email_re.match(email):
        return jsonify({'error': 'Invalid email format'}), 400

    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    pw_hash = hash_password(password)
    admin_id = g.current_user['id']
    now = datetime.now()

    conn = _get_db()
    try:
        with conn.cursor() as cur:
            # Check duplicate email
            cur.execute("SELECT id FROM wm_accounts WHERE email = %s", (email,))
            if cur.fetchone():
                return jsonify({'error': 'Email already registered'}), 409

            cur.execute(
                "INSERT INTO wm_accounts "
                "(email, password_hash, role, status, contact_name, contact_phone, "
                " company_name, company_size, business_scope, industries, expires_at, "
                " reviewed_at, reviewed_by, review_note) "
                "VALUES (%s, %s, 'user', 'approved', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (email, pw_hash, contact_name, contact_phone,
                 company_name, company_size, business_scope, industries_str,
                 expires_at, now, admin_id, 'Admin direct creation'),
            )
            new_id = cur.lastrowid

        # Create user_profiles record
        profile_user_id = str(uuid.uuid4())
        try:
            from services.user_profile import upsert_profile
            profile_data = {
                'company_name': company_name,
                'company_size': company_size,
                'business_scope': business_scope,
                'industries': industries if isinstance(industries, list) else [],
                'competitors': competitors if isinstance(competitors, list) else [],
                'supply_chain_up': supply_chain_up if isinstance(supply_chain_up, list) else [],
                'supply_chain_down': supply_chain_down if isinstance(supply_chain_down, list) else [],
            }
            profile = upsert_profile(profile_user_id, profile_data)

            if profile:
                with conn.cursor(pymysql.cursors.DictCursor) as cur:
                    cur.execute(
                        "SELECT id FROM user_profiles WHERE user_id = %s",
                        (profile_user_id,),
                    )
                    prow = cur.fetchone()
                    if prow:
                        with conn.cursor() as cur2:
                            cur2.execute(
                                "UPDATE wm_accounts SET profile_id = %s WHERE id = %s",
                                (prow['id'], new_id),
                            )
        except Exception as e:
            logger.warning(f'[admin] Profile creation for new account failed (non-blocking): {e}')

        conn.commit()
        logger.warning(f'[admin] Created account {new_id} ({email}) by admin {admin_id}')

        # Send account credentials email (non-blocking)
        try:
            from services.email_service import send_account_created
            send_account_created(
                to_email=email,
                password=password,
                contact_name=contact_name,
                company_name=company_name,
                expires_at=expires_at.strftime('%Y-%m-%d') if expires_at else '',
            )
        except Exception as e:
            logger.warning(f'[admin] Account creation email failed (non-blocking): {e}')

        return jsonify({
            'ok': True,
            'message': 'Account created and approved',
            'account_id': new_id,
            'email': email,
        }), 201
    except Exception as e:
        logger.warning(f'[admin] Create account error: {e}')
        return jsonify({'error': 'Failed to create account'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/admin/users/<id>/restore — restore a suspended user
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users/<int:user_id>/restore', methods=['POST'])
@require_admin
def restore_user(user_id):
    """Restore a suspended user back to approved status."""
    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, status FROM wm_accounts WHERE id = %s",
                (user_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'User not found'}), 404

        if account['status'] != 'suspended':
            return jsonify({'error': 'User is not suspended'}), 409

        admin_id = g.current_user['id']
        now = datetime.now()

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET status = 'approved', reviewed_at = %s, "
                "       reviewed_by = %s, review_note = 'Restored by admin' "
                "WHERE id = %s",
                (now, admin_id, user_id),
            )
        conn.commit()

        logger.warning(f'[admin] Restored user {user_id} ({account["email"]}) by admin {admin_id}')
        return jsonify({
            'ok': True,
            'message': 'User restored',
            'user_id': user_id,
        })
    except Exception as e:
        logger.warning(f'[admin] Restore error: {e}')
        return jsonify({'error': 'Failed to restore user'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# PATCH /api/admin/users/<id>/subscription — set/update subscription expiry
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users/<int:user_id>/subscription', methods=['PATCH'])
@require_admin
def update_subscription(user_id):
    """Set or update subscription expiry date for a user.

    Body: { "expires_at": "2027-03-26" }
    Or:   { "months": 12 }  — add months from today (or current expires_at if in future)
    """
    data = request.get_json(silent=True) or {}

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, status, expires_at FROM wm_accounts WHERE id = %s",
                (user_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'User not found'}), 404

        # Determine the new expires_at
        months = data.get('months')
        expires_at_str = (data.get('expires_at') or '').strip()

        if months:
            # Add months from today or current expiry (whichever is later)
            months = int(months)
            base = datetime.now()
            if account['expires_at'] and account['expires_at'] > base:
                base = account['expires_at']
            # Approximate: 30 days per month
            new_expires = base + timedelta(days=30 * months)
        elif expires_at_str:
            try:
                new_expires = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00')).replace(tzinfo=None)
            except ValueError:
                try:
                    new_expires = datetime.strptime(expires_at_str, '%Y-%m-%d')
                except ValueError:
                    return jsonify({'error': 'Invalid date format (use YYYY-MM-DD)'}), 400
        else:
            return jsonify({'error': 'Provide expires_at (YYYY-MM-DD) or months (integer)'}), 400

        admin_id = g.current_user['id']

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET expires_at = %s WHERE id = %s",
                (new_expires, user_id),
            )
        conn.commit()

        logger.warning(
            f'[admin] Updated subscription for {user_id} ({account["email"]}): '
            f'expires_at={new_expires.isoformat()} by admin {admin_id}'
        )
        return jsonify({
            'ok': True,
            'message': 'Subscription updated',
            'user_id': user_id,
            'expires_at': new_expires.isoformat(),
        })
    except Exception as e:
        logger.warning(f'[admin] Subscription update error: {e}')
        return jsonify({'error': 'Failed to update subscription'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# POST /api/admin/users/<id>/reset-password — admin resets user password
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users/<int:user_id>/reset-password', methods=['POST'])
@require_admin
def reset_password(user_id):
    """Reset user password and return the new temporary password."""
    import secrets
    import string

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, role FROM wm_accounts WHERE id = %s",
                (user_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'User not found'}), 404

        if account['role'] == 'admin':
            return jsonify({'error': 'Cannot reset admin password via this API'}), 403

        # Generate a temporary password: 12 chars, letters + digits
        alphabet = string.ascii_letters + string.digits
        new_password = ''.join(secrets.choice(alphabet) for _ in range(12))
        pw_hash = hash_password(new_password)

        admin_id = g.current_user['id']
        now = datetime.now()

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE wm_accounts SET password_hash = %s, "
                "       reviewed_at = %s, reviewed_by = %s, "
                "       review_note = %s "
                "WHERE id = %s",
                (pw_hash, now, admin_id, 'Password reset by admin', user_id),
            )
        conn.commit()

        logger.warning(
            f'[admin] Reset password for user {user_id} ({account["email"]}) by admin {admin_id}'
        )
        return jsonify({
            'ok': True,
            'message': 'Password reset successful',
            'user_id': user_id,
            'email': account['email'],
            'new_password': new_password,
        })
    except Exception as e:
        logger.warning(f'[admin] Reset password error: {e}')
        return jsonify({'error': 'Failed to reset password'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# PATCH /api/admin/users/<id> — edit user details
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users/<int:user_id>', methods=['PATCH'])
@require_admin
def edit_user(user_id):
    """Edit user account details (contact info, company info)."""
    data = request.get_json(silent=True) or {}

    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, role FROM wm_accounts WHERE id = %s",
                (user_id,),
            )
            account = cur.fetchone()

        if not account:
            return jsonify({'error': 'User not found'}), 404

        # Editable fields whitelist
        EDITABLE_FIELDS = {
            'contact_name', 'contact_phone', 'company_name',
            'company_size', 'business_scope',
        }
        updates = []
        values = []
        for field in EDITABLE_FIELDS:
            if field in data:
                updates.append(f'{field} = %s')
                values.append(data[field])

        if not updates:
            return jsonify({'error': 'No editable fields provided'}), 400

        admin_id = g.current_user['id']
        values.append(user_id)

        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE wm_accounts SET {', '.join(updates)} WHERE id = %s",
                tuple(values),
            )
        conn.commit()

        logger.warning(
            f'[admin] Edited user {user_id} ({account["email"]}): '
            f'fields={list(data.keys())} by admin {admin_id}'
        )
        return jsonify({
            'ok': True,
            'message': 'User updated',
            'user_id': user_id,
        })
    except Exception as e:
        logger.warning(f'[admin] Edit user error: {e}')
        return jsonify({'error': 'Failed to edit user'}), 500
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET /api/admin/users/<id> — get full user detail
# ---------------------------------------------------------------------------

@admin_bp.route('/api/admin/users/<int:user_id>')
@require_admin
def get_user_detail(user_id):
    """Get full user details including all registration fields."""
    conn = _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, email, role, status, company_name, contact_name, "
                "       contact_phone, company_size, business_scope, industries, "
                "       competitors, supply_chain_up, supply_chain_down, "
                "       profile_id, expires_at, last_login_at, "
                "       applied_at, reviewed_at, review_note, "
                "       created_at, updated_at "
                "FROM wm_accounts WHERE id = %s",
                (user_id,),
            )
            row = cur.fetchone()

        if not row:
            return jsonify({'error': 'User not found'}), 404

        # Serialize datetimes
        for key in ('expires_at', 'last_login_at', 'applied_at', 'reviewed_at', 'created_at', 'updated_at'):
            if row.get(key) and isinstance(row[key], datetime):
                row[key] = row[key].isoformat()

        return jsonify({'ok': True, 'user': row})
    except Exception as e:
        logger.warning(f'[admin] Get user detail error: {e}')
        return jsonify({'error': 'Failed to get user detail'}), 500
    finally:
        conn.close()
