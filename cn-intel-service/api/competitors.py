"""Competitor Intelligence API — real-time competitor data endpoint."""

import logging
from flask import Blueprint, jsonify, request
from services.error_handler import safe_route
from services.cache import cache_get, cache_set, is_trading_time
from config import Config

logger = logging.getLogger('cn-intel.competitors-api')

competitors_bp = Blueprint('competitors', __name__)


@competitors_bp.route('/api/cn/enterprise/competitors')
@safe_route(fallback_data={'competitors': [], 'formatted_text': '', 'status': 'error'})
def enterprise_competitors():
    """Get competitor intelligence for a user's tracked competitors."""
    from services.user_profile import get_profile
    from services.competitor_tracker import gather_competitor_intel

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'status': 'no_user'}), 400

    profile = get_profile(user_id)
    if not profile or not profile.get('industries'):
        return jsonify({'status': 'no_profile', 'message': '请先设置企业画像'})

    competitors = profile.get('competitors', [])
    if not competitors:
        return jsonify({'status': 'no_competitors', 'message': '请在企业画像中添加竞争对手', 'competitors': []})

    force = request.args.get('force', 'false').lower() == 'true'

    # Check cache
    cache_key = f'cn:competitor:detail:{user_id}'
    if not force:
        cached = cache_get(cache_key)
        if cached:
            return jsonify(cached)

    # Gather fresh data
    result = gather_competitor_intel(
        competitors=competitors,
        company_name=profile.get('company_name', ''),
        industries=profile.get('industries', []),
        supply_chain_up=profile.get('supply_chain_up', []),
        supply_chain_down=profile.get('supply_chain_down', []),
    )
    result['status'] = 'ok'

    # Cache with trading-aware TTL
    ttl = Config.CACHE_TTL_COMPETITOR_INTEL if is_trading_time() else Config.CACHE_TTL_COMPETITOR_INTEL_OFF
    cache_set(cache_key, result, ttl)

    return jsonify(result)
