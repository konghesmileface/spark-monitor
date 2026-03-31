from flask import Blueprint, jsonify, request, current_app
from services.media_crawler import get_social_mood, get_mood_categories, get_mood_regional, get_entity_sentiment, NEWSNOW_SOURCES
from services.cache import cache_get, cache_set
from services.error_handler import safe_route

mood_bp = Blueprint('mood', __name__)

@mood_bp.route('/api/cn/mood')
@safe_route(cache_key='cn:mood:social')
def cn_mood():
    cache_key = 'cn:mood:social'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    data = get_social_mood()
    cache_set(cache_key, data, 600)
    return jsonify(data)

@mood_bp.route('/api/cn/mood/categories')
@safe_route(cache_key='cn:mood:categories')
def cn_mood_categories():
    cache_key = 'cn:mood:categories'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    data = get_mood_categories()
    cache_set(cache_key, data, 600)
    return jsonify(data)

@mood_bp.route('/api/cn/mood/regional')
@safe_route(fallback_data={})
def cn_mood_regional():
    data = get_mood_regional()
    return jsonify(data)

@mood_bp.route('/api/cn/mood/newsnow-health')
def newsnow_health():
    """Health check for NewsNow sources — reports cache status per source."""
    from config import Config
    import time

    r = current_app.redis
    sources_status = {}
    cached_count = 0
    total = len(NEWSNOW_SOURCES)

    for source_id in NEWSNOW_SOURCES:
        cache_key = f'cn:newsnow:{source_id}'
        has_cache = False
        ttl = -1
        if r:
            try:
                ttl = r.ttl(cache_key)
                has_cache = ttl > 0
            except Exception:
                pass
        if has_cache:
            cached_count += 1
        sources_status[source_id] = {'cached': has_cache, 'ttl': ttl}

    return jsonify({
        'newsnow_url': Config.NEWSNOW_BASE_URL or None,
        'total_sources': total,
        'cached_sources': cached_count,
        'cache_hit_rate': round(cached_count / total * 100, 1) if total else 0,
        'sources': sources_status,
    })


@mood_bp.route('/api/cn/mood/co-occurrence')
@safe_route(fallback_data={'nodes': [], 'edges': []})
def cn_mood_co_occurrence():
    """Get entity co-occurrence network from social media + news.
    Returns nodes (entities) and edges (co-mention relationships)."""
    from services.co_occurrence import build_co_occurrence_network
    min_weight = max(1, int(request.args.get('min_weight', 2)))
    max_nodes = min(50, int(request.args.get('max_nodes', 30)))
    data = build_co_occurrence_network(min_weight=min_weight, max_nodes=max_nodes)
    return jsonify(data)


@mood_bp.route('/api/cn/mood/entity-sentiment')
@safe_route(fallback_data={'entities': []})
def cn_mood_entity_sentiment():
    """Get per-entity (stock) sentiment aggregation from social media.
    Query params: entity (optional, filter by entity name), top_n (default 20)."""
    entity_name = request.args.get('entity', '').strip() or None
    top_n = min(int(request.args.get('top_n', 20)), 50)

    cache_key = f'cn:mood:entity-sentiment:{entity_name or "all"}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    data = get_entity_sentiment(entity_name=entity_name, top_n=top_n)
    cache_set(cache_key, data, 300)  # 5 min cache
    return jsonify(data)


@mood_bp.route('/api/cn/mood/report')
def cn_mood_report():
    """Generate AI social mood analysis report from multi-platform data."""
    from services.report_scheduler import build_mood_report

    force = request.args.get('force', 'false').lower() == 'true'
    result = build_mood_report(force=force)
    if not result:
        return jsonify({'report': '暂无舆情数据或AI生成失败，请稍后重试。', 'generated': False})
    return jsonify(result)
