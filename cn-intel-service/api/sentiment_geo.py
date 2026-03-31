from flask import Blueprint, jsonify
from services.sentiment_geo import get_regional_sentiment
from services.cache import cache_get, cache_set
from services.error_handler import safe_route

sentiment_geo_bp = Blueprint('sentiment_geo', __name__)

@sentiment_geo_bp.route('/api/cn/sentiment/regional')
@safe_route(cache_key='cn:sentiment:regional')
def cn_sentiment_regional():
    cache_key = 'cn:sentiment:regional'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    data = get_regional_sentiment()
    cache_set(cache_key, data, 600)
    return jsonify(data)
