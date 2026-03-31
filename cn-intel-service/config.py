import os

# Load .env file if exists
_env_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, _, value = line.partition('=')
                key, value = key.strip(), value.strip()
                if key and not os.getenv(key):  # Don't override existing env vars
                    os.environ[key] = value


class Config:
    PORT = int(os.getenv('CN_INTEL_PORT', 8078))
    DEBUG = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'

    # Redis
    REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
    REDIS_PORT = int(os.getenv('REDIS_PORT', 6379))
    REDIS_DB = int(os.getenv('CN_INTEL_REDIS_DB', 2))

    # AI providers (4-provider fallback chain)
    DEEPSEEK_API_KEY = os.getenv('DEEPSEEK_API_KEY', '')
    DEEPSEEK_BASE_URL = os.getenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
    GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
    ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY', '')
    DASHSCOPE_API_KEY = os.getenv('DASHSCOPE_API_KEY', '')
    TUSHARE_TOKEN = os.getenv('TUSHARE_TOKEN', '')

    # NewsNow (optional, enables 35+ platform expansion)
    NEWSNOW_BASE_URL = os.getenv('NEWSNOW_BASE_URL', '')

    # Relay service (Telegram OSINT feed)
    RELAY_URL = os.getenv('RELAY_URL', 'http://localhost:3004')

    # Proxy
    HTTP_PROXY = os.getenv('HTTP_PROXY', '')
    HTTPS_PROXY = os.getenv('HTTPS_PROXY', '')

    # Milvus
    MILVUS_DB_PATH = os.getenv('MILVUS_DB_PATH', './data/milvus_lite.db')

    # MySQL (RDS) — credentials must be set via .env or environment variables
    MYSQL_HOST = os.getenv('MYSQL_HOST', '')
    MYSQL_PORT = int(os.getenv('MYSQL_PORT', 3306))
    MYSQL_USER = os.getenv('MYSQL_USER', '')
    MYSQL_PASSWORD = os.getenv('MYSQL_PASSWORD', '')
    MYSQL_DATABASE = os.getenv('MYSQL_DATABASE', 'market')

    # Upload
    UPLOAD_FOLDER = os.getenv('UPLOAD_FOLDER', './uploads')
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16MB

    # Cache TTLs (seconds)
    CACHE_TTL_MARKET = 120
    CACHE_TTL_SENTIMENT = 300
    CACHE_TTL_RESEARCH = 3600
    CACHE_TTL_MOOD = 600
    CACHE_TTL_HOT_EVENTS_TRADING = 120    # 2min during trading
    CACHE_TTL_HOT_EVENTS_OFF = 300         # 5min off-hours
    CACHE_TTL_BRIEF = 7200  # 2h (was 6h)
    CACHE_TTL_REGIONAL = 600
    CACHE_TTL_GOV_NEWS = 1800

    # Industry advisor TTLs (trading / non-trading)
    CACHE_TTL_INDUSTRY_BRIEF_TRADING = 900     # 15min
    CACHE_TTL_INDUSTRY_BRIEF_OFF = 3600        # 1h
    CACHE_TTL_INDUSTRY_IMPACTS_TRADING = 600   # 10min
    CACHE_TTL_INDUSTRY_IMPACTS_OFF = 1800      # 30min
    CACHE_TTL_INDUSTRY_DEEP_TRADING = 1800     # 30min
    CACHE_TTL_INDUSTRY_DEEP_OFF = 7200         # 2h

    # Morning brief TTLs
    CACHE_TTL_MORNING_BRIEF_TRADING = 3600    # 1h during trading
    CACHE_TTL_MORNING_BRIEF_OFF = 21600       # 6h off-hours
