"""Authentication service for World Monitor.

Provides:
- Password hashing/verification (bcrypt)
- Session management (token-based, stored in wm_sessions)
- require_auth / require_admin decorators
- Table initialization (wm_accounts + wm_sessions)
- Default admin account creation
"""

import logging
import os
import secrets
from datetime import datetime, timedelta
from functools import wraps

import bcrypt
import pymysql
from flask import g, jsonify, request

from config import Config

logger = logging.getLogger('cn-intel.auth')

# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(pwd: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return bcrypt.hashpw(pwd.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def verify_password(pwd: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    try:
        return bcrypt.checkpw(pwd.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# DB helper (standalone — no Flask app context needed)
# ---------------------------------------------------------------------------

def _get_db():
    """Create a fresh pymysql connection using Config settings."""
    return pymysql.connect(
        host=Config.MYSQL_HOST,
        port=Config.MYSQL_PORT,
        user=Config.MYSQL_USER,
        password=Config.MYSQL_PASSWORD,
        database=Config.MYSQL_DATABASE,
        charset='utf8mb4',
        connect_timeout=5,
        read_timeout=10,
    )


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

SESSION_TTL_DAYS = 30


def create_session(account_id: int, db_conn=None) -> str:
    """Generate a secure token, store in wm_sessions, return the token.

    If *db_conn* is provided it will be reused (caller must commit).
    Otherwise a new connection is created and committed internally.
    """
    token = secrets.token_urlsafe(48)
    expires_at = datetime.now() + timedelta(days=SESSION_TTL_DAYS)

    own_conn = db_conn is None
    conn = db_conn or _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO wm_sessions (account_id, token, expires_at) VALUES (%s, %s, %s)",
                (account_id, token, expires_at),
            )
        if own_conn:
            conn.commit()
    finally:
        if own_conn:
            conn.close()

    return token


# ---------------------------------------------------------------------------
# Auth decorators
# ---------------------------------------------------------------------------

def require_auth(f):
    """Decorator: verify Bearer token, inject ``g.current_user`` (dict)."""

    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Missing or invalid Authorization header'}), 401

        token = auth_header[7:].strip()
        if not token:
            return jsonify({'error': 'Empty token'}), 401

        conn = _get_db()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT s.account_id, s.expires_at, "
                    "       a.id, a.email, a.role, a.status, a.profile_id, "
                    "       a.company_name, a.contact_name "
                    "FROM wm_sessions s "
                    "JOIN wm_accounts a ON a.id = s.account_id "
                    "WHERE s.token = %s",
                    (token,),
                )
                row = cur.fetchone()
        finally:
            conn.close()

        if not row:
            return jsonify({'error': 'Invalid token'}), 401

        if row['expires_at'] < datetime.now():
            return jsonify({'error': 'Token expired'}), 401

        if row['status'] != 'approved' and row['role'] != 'admin':
            return jsonify({'error': 'Account not approved'}), 403

        g.current_user = {
            'id': row['id'],
            'email': row['email'],
            'role': row['role'],
            'status': row['status'],
            'profile_id': row['profile_id'],
            'company_name': row['company_name'],
            'contact_name': row['contact_name'],
        }
        return f(*args, **kwargs)

    return decorated


def require_admin(f):
    """Decorator: require_auth + role == 'admin'."""

    @wraps(f)
    @require_auth
    def decorated(*args, **kwargs):
        if g.current_user.get('role') != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)

    return decorated


# ---------------------------------------------------------------------------
# Table initialisation
# ---------------------------------------------------------------------------

_CREATE_ACCOUNTS_SQL = """
CREATE TABLE IF NOT EXISTS wm_accounts (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    email           VARCHAR(128) UNIQUE NOT NULL,
    password_hash   VARCHAR(256) NOT NULL,
    role            ENUM('user','admin') DEFAULT 'user',
    status          ENUM('pending','approved','rejected','suspended') DEFAULT 'pending',
    profile_id      BIGINT,
    applied_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at     DATETIME,
    reviewed_by     BIGINT,
    review_note     TEXT,
    company_name    VARCHAR(128),
    contact_name    VARCHAR(64),
    contact_phone   VARCHAR(32),
    company_size    VARCHAR(32),
    business_scope  TEXT,
    industries      TEXT,
    expires_at      DATETIME COMMENT '订阅到期时间',
    last_login_at   DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

_CREATE_SESSIONS_SQL = """
CREATE TABLE IF NOT EXISTS wm_sessions (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id      BIGINT NOT NULL,
    token           VARCHAR(128) UNIQUE NOT NULL,
    expires_at      DATETIME NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES wm_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

_CREATE_PASSWORD_RESETS_SQL = """
CREATE TABLE IF NOT EXISTS wm_password_resets (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id      BIGINT NOT NULL,
    code            VARCHAR(6) NOT NULL,
    expires_at      DATETIME NOT NULL,
    used_at         DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES wm_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


def init_auth_tables(mysql_conn=None):
    """Create wm_accounts and wm_sessions tables if they don't exist."""
    own_conn = mysql_conn is None
    conn = mysql_conn or _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(_CREATE_ACCOUNTS_SQL)
            cur.execute(_CREATE_SESSIONS_SQL)
            cur.execute(_CREATE_PASSWORD_RESETS_SQL)
            # Migrations: add columns if missing
            _migrations = [
                ("ALTER TABLE wm_accounts ADD COLUMN expires_at DATETIME "
                 "COMMENT '订阅到期时间' AFTER industries"),
                "ALTER TABLE wm_accounts ADD COLUMN competitors TEXT AFTER industries",
                "ALTER TABLE wm_accounts ADD COLUMN supply_chain_up TEXT AFTER industries",
                "ALTER TABLE wm_accounts ADD COLUMN supply_chain_down TEXT AFTER industries",
            ]
            for _sql in _migrations:
                try:
                    cur.execute(_sql)
                    conn.commit()
                except Exception:
                    pass  # column already exists
        conn.commit()
        logger.warning('[auth] Tables wm_accounts + wm_sessions + wm_password_resets ensured')
    except Exception as e:
        logger.warning(f'[auth] Table creation error: {e}')
    finally:
        if own_conn:
            conn.close()


# ---------------------------------------------------------------------------
# Default admin
# ---------------------------------------------------------------------------

DEFAULT_ADMIN_EMAIL = os.getenv('ADMIN_EMAIL', 'admin@worldmonitor.io')
DEFAULT_ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'admin123')


def create_default_admin(mysql_conn=None):
    """Create the default admin account if it doesn't already exist."""
    own_conn = mysql_conn is None
    conn = mysql_conn or _get_db()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id FROM wm_accounts WHERE email = %s",
                (DEFAULT_ADMIN_EMAIL,),
            )
            if cur.fetchone():
                logger.warning(f'[auth] Default admin already exists ({DEFAULT_ADMIN_EMAIL})')
                return

            pw_hash = hash_password(DEFAULT_ADMIN_PASSWORD)
            cur.execute(
                "INSERT INTO wm_accounts (email, password_hash, role, status, contact_name) "
                "VALUES (%s, %s, 'admin', 'approved', %s)",
                (DEFAULT_ADMIN_EMAIL, pw_hash, 'Admin'),
            )
        conn.commit()
        logger.warning(f'[auth] Default admin created: {DEFAULT_ADMIN_EMAIL}')
    except Exception as e:
        logger.warning(f'[auth] Default admin creation error: {e}')
    finally:
        if own_conn:
            conn.close()
