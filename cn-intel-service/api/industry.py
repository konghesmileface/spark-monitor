"""Industry Intelligence API — industry-perspective analysis endpoints."""

import logging
from flask import Blueprint, jsonify, request
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.industry-api')

industry_bp = Blueprint('industry', __name__)


@industry_bp.route('/api/cn/industry/brief')
@safe_route(fallback_data={'headline': '产业简报暂时不可用', 'key_developments': []})
def industry_brief():
    """AI-powered daily industry brief, personalized to user profile."""
    from services.industry_advisor import generate_industry_brief

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': 'user_id is required'}), 400
    brief = generate_industry_brief(user_id)
    return jsonify(brief)


@industry_bp.route('/api/cn/industry/impacts')
@safe_route(fallback_data=[])
def industry_impacts():
    """Lightweight policy impact list — no AI, keyword-based."""
    from services.industry_advisor import get_industry_impacts

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': 'user_id is required'}), 400
    limit = min(int(request.args.get('limit', '10')), 30)
    impacts = get_industry_impacts(user_id, limit=limit)
    return jsonify(impacts)


@industry_bp.route('/api/cn/industry/deep-analysis', methods=['POST'])
@safe_route(fallback_data={'error': '深度分析暂时不可用'})
def industry_deep_analysis():
    """Deep-analyze a single policy for specific industries (AI)."""
    from services.industry_advisor import analyze_policy_for_industry

    body = request.get_json(silent=True) or {}
    policy_item = body.get('policy', {})
    industries = body.get('industries', [])
    if not policy_item.get('title'):
        return jsonify({'error': 'policy.title is required'}), 400
    if not industries:
        return jsonify({'error': 'industries list is required'}), 400
    result = analyze_policy_for_industry(policy_item, industries)
    return jsonify(result)
