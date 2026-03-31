"""Insights API — cross-domain correlations, trade ideas, market regime.

Caching strategy (Redis DB 2):
  - correlations: 4h (14400s) — gathers policy+sentiment+market signals
  - trade-ideas:  6h (21600s) — expensive AI call
  - regime:       4h (14400s) — lightweight market state
  - analyze-signal: 4h (14400s) — per-signal AI analysis
"""

import hashlib
import json
import logging
from flask import Blueprint, jsonify, request
from services.cache import cache_get_or_compute
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.insights-api')

insights_bp = Blueprint('insights', __name__)


@insights_bp.route('/api/cn/insights/correlations')
@safe_route(fallback_data={'policy': {}, 'sentiment': {}, 'market': {}})
def get_correlations():
    """Get three-domain correlation signals (cached 4h)."""
    from services.cross_domain_engine import build_correlation_context, detect_cross_signals

    sectors_param = request.args.get('sectors', '')
    sectors = [s.strip() for s in sectors_param.split(',') if s.strip()] if sectors_param else None

    cache_key = 'cn:insights:correlations'
    if sectors:
        cache_key += ':' + ','.join(sorted(sectors))

    def compute():
        context = build_correlation_context(sectors)
        signals = detect_cross_signals(context)
        return {
            'context': context,
            'signals': signals,
            'total_signals': len(signals),
        }

    result = cache_get_or_compute(cache_key, compute, ttl=14400, lock_timeout=60)
    return jsonify(result or {'context': {}, 'signals': [], 'total_signals': 0})


@insights_bp.route('/api/cn/insights/trade-ideas')
@safe_route(fallback_data={'ideas': []})
def get_trade_ideas():
    """Generate AI-powered trade ideas (cached 6h)."""
    from services.cross_domain_engine import generate_trade_ideas

    user_id = request.args.get('user_id', '').strip()

    cache_key = f'cn:insights:trade-ideas:{user_id or "global"}'

    def compute():
        ideas = generate_trade_ideas(user_id=user_id or None)
        return {
            'ideas': ideas,
            'total': len(ideas),
            'user_id': user_id,
        }

    result = cache_get_or_compute(cache_key, compute, ttl=21600, lock_timeout=60)
    return jsonify(result or {'ideas': [], 'total': 0, 'user_id': user_id})


@insights_bp.route('/api/cn/insights/analyze-signal', methods=['POST'])
@safe_route(fallback_data={'analysis': '分析暂时不可用'})
def analyze_signal():
    """Deep AI analysis of a specific cross-domain signal (cached 4h)."""
    from services.ai_analysis import call_ai

    data = request.get_json(silent=True) or {}
    signal = data.get('signal', {})
    if not signal:
        return jsonify({'error': '缺少signal'}), 400

    sector = signal.get('sector', '未知')
    pattern = signal.get('pattern', '')
    direction = signal.get('direction', '')

    # Cache key based on signal content hash
    sig_hash = hashlib.md5(json.dumps(signal, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    cache_key = f'cn:insights:signal-analysis:{sig_hash}'

    def compute():
        prompt = (
            f'对以下A股跨域信号进行深度分析:\n'
            f'板块: {sector}\n'
            f'模式: {pattern} (方向: {direction})\n'
            f'政策: {signal.get("policy_detail", {})}\n'
            f'舆情: {signal.get("sentiment_detail", {})}\n'
            f'市场: {signal.get("market_detail", {})}\n\n'
            f'请分析: 1)信号可靠性 2)历史相似情况 3)未来可能走势 4)操作建议'
        )
        analysis = call_ai(prompt, max_tokens=1500)
        return {'analysis': analysis or '分析生成失败', 'signal': signal}

    result = cache_get_or_compute(cache_key, compute, ttl=14400, lock_timeout=60)
    return jsonify(result)


@insights_bp.route('/api/cn/insights/regime')
@safe_route(fallback_data={'regime': 'range_bound', 'label': '区间震荡'})
def get_regime():
    """Get current market regime (cached 4h)."""
    from services.cross_domain_engine import detect_regime

    result = cache_get_or_compute('cn:insights:regime', detect_regime, ttl=14400, lock_timeout=30)
    return jsonify(result or {'regime': 'range_bound', 'label': '区间震荡'})
