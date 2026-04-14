import logging
import os
from datetime import datetime
from flask import Flask, g, jsonify, request
from flask_cors import CORS

# Ensure localhost requests bypass proxy (HTTP_PROXY routes localhost through Clash → 502)
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')

# Setup logging
logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s'
)
logger = logging.getLogger('cn-intel')

# Rate limiter (initialized in create_app)
limiter = None

def create_app():
    app = Flask(__name__)
    CORS(app, origins=[
        'http://localhost:*', 'https://localhost:*',
        'http://127.0.0.1:*', 'https://127.0.0.1:*',
        'https://worldmonitor.io', 'https://*.worldmonitor.io',
        'https://sparkmonitor.cn', 'https://*.sparkmonitor.cn',
        'https://*.vercel.app',
        'tauri://localhost',
    ])

    from config import Config
    app.config.from_object(Config)
    app.config['MAX_CONTENT_LENGTH'] = Config.MAX_CONTENT_LENGTH
    app.json.sort_keys = False  # Preserve dict insertion order (platform tab ordering)

    # Initialize Redis with connection pool (shared across threads)
    try:
        import redis
        redis_pool = redis.ConnectionPool(
            host=Config.REDIS_HOST,
            port=Config.REDIS_PORT,
            db=Config.REDIS_DB,
            decode_responses=True,
            max_connections=50,
            socket_connect_timeout=3,
            socket_timeout=5,
            retry_on_timeout=True,
        )
        app.redis = redis.Redis(connection_pool=redis_pool)
        app.redis.ping()
        logger.warning(f'Redis connected: DB {Config.REDIS_DB} (pool max=50)')
    except Exception as e:
        logger.warning(f'Redis not available: {e}, using in-memory cache')
        app.redis = None

    # Rate limiter
    global limiter
    try:
        from flask_limiter import Limiter
        from flask_limiter.util import get_remote_address
        storage_uri = f'redis://{Config.REDIS_HOST}:{Config.REDIS_PORT}/{Config.REDIS_DB}' if app.redis else 'memory://'
        limiter = Limiter(
            get_remote_address,
            app=app,
            default_limits=['200/minute'],
            storage_uri=storage_uri,
        )
        logger.warning(f'Rate limiter initialized ({storage_uri})')
    except ImportError:
        logger.warning('flask-limiter not installed, rate limiting disabled')
    except Exception as e:
        logger.warning(f'Rate limiter init failed: {e}')

    # Initialize auth tables + default admin (requires MySQL)
    if Config.MYSQL_HOST:
        try:
            from services.auth_service import init_auth_tables, create_default_admin
            init_auth_tables()
            create_default_admin()
        except Exception as e:
            logger.warning(f'Auth table init failed (non-blocking): {e}')

    # Global error handlers — always return JSON, never HTML 500
    @app.errorhandler(Exception)
    def handle_exception(e):
        logger.warning(f'Unhandled exception: {e}')
        return jsonify({'error': str(e), 'code': 500}), 500

    @app.errorhandler(404)
    def handle_404(e):
        return jsonify({'error': 'Not found', 'code': 404}), 404

    # Health check
    @app.route('/api/cn/health')
    def health():
        return jsonify({
            'status': 'ok',
            'service': 'cn-intel-service',
            'redis': app.redis is not None
        })

    # Source health endpoint
    @app.route('/api/cn/health/sources')
    def health_sources():
        """Per-source health metrics from last crawl cycle."""
        if not app.redis:
            return jsonify({'error': 'Redis not available'}), 503
        from services.gov_news_crawler import GOV_SOURCES
        import json
        sources = {}
        for key in GOV_SOURCES:
            raw = app.redis.get(f'cn:health:{key}')
            if raw:
                try:
                    sources[key] = json.loads(raw)
                except Exception:
                    sources[key] = {'raw': raw}
            else:
                sources[key] = {'count': -1, 'ts': None}
        # Summary
        total = len(sources)
        ok = sum(1 for v in sources.values() if v.get('count', 0) > 0)
        empty = sum(1 for v in sources.values() if v.get('count', 0) == 0 and v.get('ts'))
        missing = sum(1 for v in sources.values() if v.get('count', -1) == -1)
        return jsonify({
            'summary': {'total': total, 'ok': ok, 'empty': empty, 'not_checked': missing},
            'sources': sources,
        })

    # ── Global auth gate: protect all /api/cn/* except whitelist ──
    AUTH_PUBLIC_PREFIXES = (
        '/api/cn/health',
        '/api/auth/',           # login, register, status
    )

    # Internal service key for relay seeder and other server-side callers
    _INTERNAL_KEY = os.environ.get('CN_INTEL_INTERNAL_KEY', 'cn-intel-relay-2026')

    @app.before_request
    def _require_auth_global():
        """Reject unauthenticated requests to intelligence APIs.

        Uses Redis to cache validated tokens (60s TTL) so that 500 concurrent
        users don't each trigger a MySQL query on every request.
        """
        path = request.path

        # Allow public endpoints
        for prefix in AUTH_PUBLIC_PREFIXES:
            if path.startswith(prefix):
                return None

        # Allow OPTIONS (CORS preflight)
        if request.method == 'OPTIONS':
            return None

        # Everything else under /api/ requires auth
        if not path.startswith('/api/'):
            return None

        # Allow internal service calls (relay seeder, etc.)
        internal_key = request.headers.get('X-Internal-Key', '')
        if internal_key and internal_key == _INTERNAL_KEY:
            g.current_user = {'id': 0, 'email': 'internal@system', 'role': 'admin', 'status': 'approved'}
            return None

        auth_header = request.headers.get('Authorization', '')
        token = ''
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
        # SSE EventSource can't send headers — accept token as query param
        if not token:
            token = request.args.get('token', '').strip()
        if not token:
            return jsonify({'error': 'Authentication required'}), 401
        if not token:
            return jsonify({'error': 'Empty token'}), 401

        import json as _json

        # ── Try Redis cache first ──
        cache_key = f'cn:auth:token:{token[:16]}'
        if app.redis:
            try:
                cached = app.redis.get(cache_key)
                if cached:
                    user = _json.loads(cached)
                    g.current_user = user
                    return None
            except Exception:
                pass  # Redis down — fall through to MySQL

        # ── MySQL lookup ──
        import pymysql
        from services.db_pool import get_connection
        try:
            conn = get_connection()
        except Exception as e:
            logger.warning(f'Auth DB connect failed: {e}')
            return jsonify({'error': 'Service temporarily unavailable'}), 503
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

        # Inject user into request context
        user = {
            'id': row['id'],
            'email': row['email'],
            'role': row['role'],
            'status': row['status'],
            'profile_id': row['profile_id'],
            'company_name': row['company_name'],
            'contact_name': row['contact_name'],
        }
        g.current_user = user

        # ── Cache in Redis (60s TTL) ──
        if app.redis:
            try:
                app.redis.setex(cache_key, 60, _json.dumps(user, default=str))
            except Exception:
                pass

        return None

    # Register API blueprints
    from api.market import market_bp
    from api.sentiment import sentiment_bp
    from api.research import research_bp
    from api.rag import rag_bp
    from api.mood import mood_bp
    from api.hot_events import hot_events_bp
    from api.brief import brief_bp
    from api.sentiment_geo import sentiment_geo_bp
    from api.research_upload import research_upload_bp
    from api.gov_news import gov_news_bp
    from api.stock import stock_bp
    from api.profile import profile_bp
    from api.sweep import sweep_bp
    from api.alerts import alerts_bp
    from api.insights import insights_bp
    from api.enterprise import enterprise_bp
    from api.telegram import telegram_bp
    from api.industry import industry_bp
    from api.competitors import competitors_bp
    from api.auth import auth_bp
    from api.admin import admin_bp

    app.register_blueprint(market_bp)
    app.register_blueprint(sentiment_bp)
    app.register_blueprint(research_bp)
    app.register_blueprint(rag_bp)
    # Apply stricter rate limits to AI endpoints
    if limiter:
        limiter.limit('10/minute')(app.view_functions.get('rag.cn_rag_ask', lambda: None))
        limiter.limit('10/minute')(app.view_functions.get('rag.cn_rag_ask_stream', lambda: None))
        limiter.limit('20/minute')(app.view_functions.get('brief.cn_brief', lambda: None))
    app.register_blueprint(mood_bp)
    app.register_blueprint(hot_events_bp)
    app.register_blueprint(brief_bp)
    app.register_blueprint(sentiment_geo_bp)
    app.register_blueprint(research_upload_bp)
    app.register_blueprint(gov_news_bp)
    app.register_blueprint(stock_bp)
    app.register_blueprint(profile_bp)
    app.register_blueprint(sweep_bp)
    app.register_blueprint(alerts_bp)
    app.register_blueprint(insights_bp)
    app.register_blueprint(enterprise_bp)
    app.register_blueprint(telegram_bp)
    app.register_blueprint(industry_bp)
    app.register_blueprint(competitors_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    # Rate limits for industry AI endpoints
    if limiter:
        limiter.limit('10/minute')(app.view_functions.get('industry.industry_brief', lambda: None))
        limiter.limit('5/minute')(app.view_functions.get('industry.industry_deep_analysis', lambda: None))
        # Rate limits for research AI endpoints
        limiter.limit('5/minute')(app.view_functions.get('research.cn_research_analyze', lambda: None))
        limiter.limit('10/minute')(app.view_functions.get('research.cn_research_chat', lambda: None))
        limiter.limit('5/minute')(app.view_functions.get('research_upload.upload_research', lambda: None))

    # Initialize data providers (akshare + tushare)
    from services.data_provider import _init_akshare, _init_tushare, start_bg_refresh
    _init_akshare()
    _init_tushare()

    # Start background spot data refresh (in-memory cache)
    start_bg_refresh()

    # Register AI tool registry
    from services.tool_registry import register_all_tools
    register_all_tools()

    # Start background report scheduler (auto-generate mood + gov reports)
    from services.report_scheduler import start_report_scheduler
    start_report_scheduler(app)

    # Start background alert scanner (scan news/policy against user profiles)
    from services.alert_scanner import start_alert_scanner
    start_alert_scanner(app)

    return app

# Module-level app instance for gunicorn (gunicorn app:app)
app = create_app()

if __name__ == '__main__':
    from config import Config
    logger.warning(f'Starting cn-intel-service on port {Config.PORT}')
    app.run(host='0.0.0.0', port=Config.PORT, debug=Config.DEBUG, threaded=True)
