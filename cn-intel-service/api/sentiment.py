from flask import Blueprint, jsonify
from services.akshare_data import get_sentiment_data
from services.cache import cache_get, cache_set, cache_get_stale, is_trading_time
from services.error_handler import safe_route

sentiment_bp = Blueprint('sentiment', __name__)


def _is_empty_sentiment(data):
    """Check if sentiment data is effectively empty."""
    if not data or not isinstance(data, dict):
        return True
    return data.get('score') is None and not data.get('factors')


@sentiment_bp.route('/api/cn/sentiment')
@safe_route(cache_key='cn:sentiment:index')
def cn_sentiment():
    cache_key = 'cn:sentiment:index'
    cached = cache_get(cache_key)

    if not is_trading_time():
        if cached and not _is_empty_sentiment(cached):
            return jsonify(cached)
        stale = cache_get_stale(cache_key)
        if stale and not _is_empty_sentiment(stale):
            stale['_stale'] = True
            cache_set(cache_key, stale, 21600)
            return jsonify(stale)

    if cached and not _is_empty_sentiment(cached):
        return jsonify(cached)

    data = get_sentiment_data()

    if _is_empty_sentiment(data):
        stale = cache_get_stale(cache_key)
        if stale and not _is_empty_sentiment(stale):
            stale['_stale'] = True
            return jsonify(stale)
        return jsonify(data)

    ttl = 300 if is_trading_time() else 21600
    cache_set(cache_key, data, ttl)
    return jsonify(data)
