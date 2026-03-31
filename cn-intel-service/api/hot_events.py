from flask import Blueprint, jsonify
from services.hot_events import get_hot_events
from services.cache import cache_get, cache_set, is_trading_time
from services.error_handler import safe_route
from config import Config

hot_events_bp = Blueprint('hot_events', __name__)

@hot_events_bp.route('/api/cn/hot-events')
@safe_route(cache_key='cn:hot-events:latest')
def cn_hot_events():
    cache_key = 'cn:hot-events:latest'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    data = get_hot_events()
    ttl = Config.CACHE_TTL_HOT_EVENTS_TRADING if is_trading_time() else Config.CACHE_TTL_HOT_EVENTS_OFF
    cache_set(cache_key, data, ttl)
    return jsonify(data)
