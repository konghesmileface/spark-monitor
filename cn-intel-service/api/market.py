from flask import Blueprint, jsonify, current_app
from services.akshare_data import get_market_overview
from services.cache import cache_get, cache_set, cache_get_stale, is_trading_time, get_redis
from services.error_handler import safe_route
import logging
import time

_market_logger = logging.getLogger('cn-intel.market')

market_bp = Blueprint('market', __name__)


def _is_empty_market(data):
    """Check if market data is effectively empty or partially broken."""
    if not data or not isinstance(data, dict):
        return True
    if not data.get('indices'):
        return True
    # Also consider empty if sectors + northbound + limitStats are all missing/zero
    has_sectors = bool(data.get('sectors'))
    north = data.get('northbound', {})
    has_north = north.get('total', 0) != 0 or north.get('shConnect', 0) != 0
    stats = data.get('limitStats', {})
    has_stats = stats.get('up', 0) != 0 or stats.get('down', 0) != 0
    if not has_sectors and not has_north and not has_stats:
        return True
    return False


@market_bp.route('/api/cn/market')
@safe_route(cache_key='cn:market:overview')
def cn_market():
    cache_key = 'cn:market:overview'
    cached = cache_get(cache_key)

    # Non-trading hours: prefer cached data, don't hammer eastmoney
    if not is_trading_time():
        if cached and not _is_empty_market(cached):
            return jsonify(cached)
        # Cache expired or empty — try stale data
        stale = cache_get_stale(cache_key)
        if stale and not _is_empty_market(stale):
            stale['_stale'] = True
            # Re-cache stale data with long TTL to avoid repeated lookups
            cache_set(cache_key, stale, 21600)  # 6h
            return jsonify(stale)
        # No stale data at all — try fetching anyway (may get last-close data)

    if cached and not _is_empty_market(cached):
        return jsonify(cached)

    # Stampede protection: only one request fetches market data at a time
    r = get_redis()
    lock_key = f'{cache_key}:lock'
    acquired = False
    if r:
        try:
            acquired = r.set(lock_key, '1', ex=15, nx=True)
        except Exception:
            acquired = True  # Redis error → just compute
        if not acquired:
            # Another request is fetching — wait for it
            deadline = time.time() + 10
            while time.time() < deadline:
                time.sleep(0.3)
                cached = cache_get(cache_key)
                if cached and not _is_empty_market(cached):
                    return jsonify(cached)
            _market_logger.debug('Market stampede lock wait timed out, computing')
    else:
        acquired = True

    try:
        data = get_market_overview()
    finally:
        if acquired and r:
            try:
                r.delete(lock_key)
            except Exception:
                pass

    # Don't cache empty results — keep stale data alive
    if _is_empty_market(data):
        stale = cache_get_stale(cache_key)
        if stale and not _is_empty_market(stale):
            stale['_stale'] = True
            return jsonify(stale)
        # Nothing available at all
        return jsonify(data)

    ttl = 120 if is_trading_time() else 21600  # 2min trading, 6h non-trading
    cache_set(cache_key, data, ttl)
    return jsonify(data)
