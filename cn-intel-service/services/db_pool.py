"""MySQL connection pool using DBUtils.

Provides get_connection() that returns a pooled connection.
Falls back to direct pymysql.connect() if DBUtils is not installed.

Pool sizing: designed for gunicorn with 4 workers × 16 threads = 64 max concurrency.
Each worker gets its own pool (fork), so per-worker pool needs ~20 connections headroom.
"""
import logging
import pymysql
from config import Config

logger = logging.getLogger('cn-intel.db')

_pool = None


def _init_pool():
    global _pool
    if _pool is not None:
        return
    if not Config.MYSQL_HOST:
        logger.warning('MySQL not configured (MYSQL_HOST empty), pool disabled')
        return
    try:
        from dbutils.pooled_db import PooledDB
        _pool = PooledDB(
            creator=pymysql,
            maxconnections=20,
            mincached=3,
            maxcached=10,
            blocking=True,
            maxusage=2000,
            ping=1,
            setsession=[],
            host=Config.MYSQL_HOST,
            port=Config.MYSQL_PORT,
            user=Config.MYSQL_USER,
            password=Config.MYSQL_PASSWORD,
            database=Config.MYSQL_DATABASE,
            charset='utf8mb4',
            connect_timeout=5,
            read_timeout=15,
        )
        logger.warning('MySQL connection pool initialized (max=20, ping=1)')
    except ImportError:
        logger.warning('DBUtils not installed, using direct pymysql connections')
    except Exception as e:
        logger.warning(f'MySQL pool init failed: {e}')


def get_connection():
    """Get a database connection (pooled if available, direct otherwise).
    Caller MUST close the connection when done (returns to pool)."""
    _init_pool()
    if _pool:
        return _pool.connection()
    # Fallback: direct connection
    return pymysql.connect(
        host=Config.MYSQL_HOST,
        port=Config.MYSQL_PORT,
        user=Config.MYSQL_USER,
        password=Config.MYSQL_PASSWORD,
        database=Config.MYSQL_DATABASE,
        charset='utf8mb4',
        connect_timeout=5,
        read_timeout=15,
    )
