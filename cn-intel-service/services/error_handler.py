"""Global error handling and safe_route decorator for cn-intel-service.
Provides graceful degradation: on exception, returns stale cached data or fallback JSON."""

import logging
import traceback
from functools import wraps
from flask import jsonify

logger = logging.getLogger('cn-intel.error')


def safe_route(cache_key=None, fallback_data=None):
    """Decorator: wraps a Flask route with try/except + cache degradation.

    On exception:
      1. If cache_key is set, try to return stale cached data with _stale=True
      2. Otherwise return fallback_data (or standard error JSON)

    Usage:
        @bp.route('/api/cn/market')
        @safe_route(cache_key='cn:market:overview')
        def cn_market():
            ...
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except Exception as e:
                logger.warning(f'[safe_route] {fn.__name__} failed: {e}\n{traceback.format_exc()}')

                # Try returning stale cached data
                if cache_key:
                    try:
                        from services.cache import cache_get, _memory_cache
                        # Try normal cache first (may still have expired memory data)
                        stale = cache_get(cache_key)
                        if stale is None:
                            # Try memory cache ignoring TTL
                            stale = _memory_cache.get(cache_key)
                        if stale is not None:
                            if isinstance(stale, dict):
                                stale['_stale'] = True
                            return jsonify(stale)
                    except Exception:
                        pass

                # Return fallback data
                if fallback_data is not None:
                    fb = fallback_data.copy() if isinstance(fallback_data, dict) else fallback_data
                    if isinstance(fb, dict):
                        fb['_stale'] = True
                    return jsonify(fb)

                # Standard error JSON
                return jsonify({
                    'error': f'服务暂时不可用: {type(e).__name__}',
                    'code': 500,
                    '_stale': False,
                }), 500
        return wrapper
    return decorator
