"""Government & official media news API endpoints.
Includes live crawling, AI report, historical data from MySQL,
and AI analysis/chat for individual policy articles."""

import json
import logging
import threading
from datetime import date, datetime, timedelta
from flask import Blueprint, jsonify, request, current_app
from services.gov_news_crawler import get_gov_news, GOV_CATEGORIES, GOV_SOURCES
from services.article_fetcher import fetch_article, can_fetch, is_api_fetcher_domain
from services.cache import cache_get, cache_set, cache_get_stale, cache_set_stale
from services.ai_analysis import call_ai
from services import policy_store
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.gov-news-api')

gov_news_bp = Blueprint('gov_news', __name__)

# Track background refresh to avoid duplicate threads
_refresh_lock = threading.Lock()
_refreshing_keys: set = set()


def _background_refresh(app, cache_key, categories):
    """Background thread: crawl gov news and update cache."""
    with app.app_context():
        try:
            data = get_gov_news(categories=categories)
            cache_set(cache_key, data, 7200)  # 2-hour fresh cache (was 30min)
            cache_set_stale(cache_key, data)  # 7-day stale fallback
            if not categories:
                _auto_store(data)
            logger.warning(f'[gov-news] Background refresh done: {data.get("total", 0)} items')
        except Exception as e:
            logger.warning(f'[gov-news] Background refresh failed: {e}')
        finally:
            with _refresh_lock:
                _refreshing_keys.discard(cache_key)


def _get_mysql_fallback(category=None):
    """Fast fallback: load recent policy news from MySQL (< 1 second).
    Ensures all categories are represented by fetching per-category."""
    try:
        today = date.today()
        start = (today - timedelta(days=7)).isoformat()
        end = today.isoformat()

        if category:
            # Single category request
            items = policy_store.get_items_by_date_range(start, end, category=category, limit=500)
        else:
            # Fetch per-category to ensure representation from all categories
            items = []
            seen_urls = set()
            for cat in GOV_CATEGORIES:
                cat_items = policy_store.get_items_by_date_range(start, end, category=cat, limit=50)
                for it in cat_items:
                    url = it.get('url', '')
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        items.append(it)
            # Sort by date desc
            items.sort(key=lambda x: x.get('date', '') or x.get('crawled_at', ''), reverse=True)

        if not items:
            return None

        # Group by category
        by_category = {}
        source_counts = {}
        for it in items:
            cat = it.get('category', '其他')
            if cat not in by_category:
                by_category[cat] = []
            by_category[cat].append(it)
            # Build source counts
            sk = it.get('source_key', '')
            if sk:
                source_counts[sk] = source_counts.get(sk, 0) + 1

        return {
            'categories': by_category,
            'all': items[:500],
            'sources': source_counts,
            'total': len(items),
            'category_list': GOV_CATEGORIES,
            'timestamp': datetime.now().isoformat(),
            '_from_db': True,
        }
    except Exception as e:
        logger.warning(f'[gov-news] MySQL fallback failed: {e}')
        return None


# ── Live crawl endpoints ──────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/gov-news')
@safe_route(cache_key='cn:gov-news')
def cn_gov_news():
    """Fetch government news, optionally filtered by category.
    Uses stale-while-revalidate: on cache miss, returns MySQL data
    immediately and refreshes cache in background."""
    category = request.args.get('category', '')

    if category:
        cache_key = f'cn:gov-news:{category}'
        categories = [category]
    else:
        cache_key = 'cn:gov-news'
        categories = None

    # 1. Cache hit → return immediately
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    # 2. Cache miss → try stale cache
    stale = cache_get_stale(cache_key)

    # 3. Kick off background refresh (only one thread per key)
    with _refresh_lock:
        if cache_key not in _refreshing_keys:
            _refreshing_keys.add(cache_key)
            app = current_app._get_current_object()
            t = threading.Thread(target=_background_refresh,
                                 args=(app, cache_key, categories),
                                 daemon=True)
            t.start()

    # 4. Return stale cache if available
    if stale:
        if isinstance(stale, dict):
            stale['_stale'] = True
        return jsonify(stale)

    # 5. No cache at all → return MySQL historical data
    db_data = _get_mysql_fallback(category)
    if db_data:
        return jsonify(db_data)

    # 6. Nothing available → return empty structure (frontend shows loading)
    return jsonify({
        'categories': {},
        'all': [],
        'sources': {},
        'total': 0,
        'category_list': GOV_CATEGORIES,
        'timestamp': datetime.now().isoformat(),
        '_loading': True,
    })


@gov_news_bp.route('/api/cn/gov-news/report')
def cn_gov_report():
    """Generate AI policy daily report from government news."""
    from services.report_scheduler import build_gov_report

    force = request.args.get('force', 'false').lower() == 'true'
    result = build_gov_report(force=force)
    if not result:
        return jsonify({
            'report': '暂无官方新闻数据或AI生成失败，请稍后重试。',
            'generated': False,
        })
    return jsonify(result)


@gov_news_bp.route('/api/cn/gov-news/content')
def cn_gov_content():
    """Fetch article content from a government/media news URL."""
    url = request.args.get('url', '').strip()
    if not url:
        return jsonify({'error': '缺少url参数'}), 400

    # Cache by URL hash
    import hashlib
    url_hash = hashlib.md5(url.encode()).hexdigest()
    cache_key = f'cn:gov-content:{url_hash}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    # Optional title/keyword for trending page search (e.g. Toutiao trending)
    title_kw = request.args.get('title', '').strip()

    # Check if URL is a JS-SPA domain (skip fetch, return immediately)
    if not can_fetch(url):
        return jsonify({'error': 'js_spa', 'message': '该网站为单页应用，无法抓取正文', 'url': url}), 404

    result = fetch_article(url, keyword=title_kw)
    if not result:
        # For API-fetcher domains (bilibili, toutiao) or sites that block
        # server IPs (reuters, etc.), return js_spa style so frontend
        # shows excerpt + redirect button instead of a hard error
        _PAYWALL_DOMAINS = ('nytimes.com', 'wsj.com', 'ft.com', 'bloomberg.com')
        if is_api_fetcher_domain(url) or any(d in url for d in _PAYWALL_DOMAINS):
            return jsonify({'error': 'js_spa', 'message': '该内容暂时无法提取正文，请前往原文查看', 'url': url}), 404
        return jsonify({'error': '无法获取正文内容', 'url': url}), 404

    cache_set(cache_key, result, 3600)  # 1h cache
    return jsonify(result)


# ── Historical data endpoints (MySQL) ─────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/history')
@safe_route(fallback_data={'items': [], 'total': 0})
def policy_history():
    """Get historical policy news by date range.
    Query params: start, end, category, source, limit"""
    start = request.args.get('start', '')
    end = request.args.get('end', '')
    category = request.args.get('category', '')
    source = request.args.get('source', '')
    limit = min(int(request.args.get('limit', 500)), 1000)

    if not start:
        start = (date.today() - timedelta(days=7)).isoformat()
    if not end:
        end = date.today().isoformat()

    items = policy_store.get_items_by_date_range(start, end, category, source, limit)

    # Optional: sort by relevance if user_id provided
    user_id = request.args.get('user_id', '').strip()
    if user_id:
        try:
            from services.user_profile import get_profile
            from services.relevance_scorer import enrich_items_with_relevance
            profile = get_profile(user_id)
            if profile:
                items = enrich_items_with_relevance(items, profile)
                items.sort(key=lambda x: x.get('_relevance_score', 0), reverse=True)
        except Exception:
            pass

    return jsonify({
        'items': items,
        'total': len(items),
        'start': start,
        'end': end,
        'filters': {'category': category, 'source': source},
    })


@gov_news_bp.route('/api/cn/policy/search')
@safe_route(fallback_data={'items': [], 'total': 0})
def policy_search():
    """Search historical policy news by keyword.
    Query params: q, limit"""
    keyword = request.args.get('q', '').strip()
    if not keyword:
        return jsonify({'items': [], 'total': 0, 'query': ''})

    limit = min(int(request.args.get('limit', 100)), 500)
    items = policy_store.search_items(keyword, limit)
    return jsonify({
        'items': items,
        'total': len(items),
        'query': keyword,
    })


@gov_news_bp.route('/api/cn/policy/stats')
@safe_route()
def policy_stats():
    """Get policy database statistics."""
    stats = policy_store.get_stats()
    date_summary = policy_store.get_date_summary(30)
    return jsonify({
        **stats,
        'date_summary': date_summary,
        'source_list': {k: v['name'] for k, v in GOV_SOURCES.items()},
        'category_list': GOV_CATEGORIES,
    })


# ── Policy Timeline ───────────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/timeline', methods=['POST'])
@safe_route()
def policy_timeline():
    """Build a policy evolution timeline for a topic.
    Body JSON: { topic, title? }
    Returns: { topic, events, inflection_points, overall_trend, current_phase }"""
    data = request.get_json(silent=True) or {}
    topic = data.get('topic', '').strip()
    title = data.get('title', '').strip()

    if not topic and not title:
        return jsonify({'error': '缺少topic或title参数'}), 400

    search_topic = topic or title
    import hashlib
    tl_hash = hashlib.md5(search_topic.encode()).hexdigest()
    tl_cache_key = f'cn:policy:timeline:{tl_hash}'
    cached = cache_get(tl_cache_key)
    if cached:
        return jsonify(cached)

    # Get full history of related policies
    keywords = [k for k in search_topic.split() if len(k) >= 2]
    if not keywords:
        keywords = [search_topic[:6]] if len(search_topic) >= 2 else [search_topic]

    from services.policy_store import search_items_full_history
    items = search_items_full_history(keywords, limit=200)

    if not items:
        return jsonify({
            'topic': search_topic,
            'events': [],
            'inflection_points': [],
            'overall_trend': '数据库中未找到相关政策记录',
            'current_phase': '',
        })

    # Build title list for AI to analyze
    title_list = '\n'.join([f"- [{it['date']}] {it['title']} ({it.get('source','')})" for it in items[:100]])

    prompt = f"""分析以下政策主题的历史演变脉络：

主题关键词：{search_topic}

相关政策列表（按时间倒序）：
{title_list}

请从中选出15-25个最具代表性的关键节点，分析政策方向的变化。以JSON格式返回（不要markdown代码块）：
{{
  "events": [
    {{"date": "YYYY-MM-DD", "title": "政策标题", "direction": "松/紧/中性", "significance": "高/中/低", "summary": "20字内概述"}}
  ],
  "inflection_points": [
    {{"date": "YYYY-MM-DD", "title": "转折点政策", "from_direction": "松/紧/中性", "to_direction": "松/紧/中性", "reason": "30字内原因"}}
  ],
  "overall_trend": "总体趋势描述（50字以内）",
  "current_phase": "当前所处阶段描述（30字以内）"
}}

注意：direction用"松"表示宽松/利好/刺激，"紧"表示收紧/利空/限制，"中性"表示维持不变。"""

    result_text = call_ai(
        prompt,
        system_prompt='你是中国政策演变分析专家。精准判断每个政策节点的方向（松/紧/中性），找出关键转折点。',
        max_tokens=2000,
    )

    result = {
        'topic': search_topic,
        'events': [],
        'inflection_points': [],
        'overall_trend': '',
        'current_phase': '',
        'total_items': len(items),
    }

    if result_text:
        try:
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            parsed = json.loads(cleaned.strip())
            result['events'] = parsed.get('events', [])
            result['inflection_points'] = parsed.get('inflection_points', [])
            result['overall_trend'] = parsed.get('overall_trend', '')
            result['current_phase'] = parsed.get('current_phase', '')
        except (json.JSONDecodeError, ValueError):
            # Fallback: use raw items as events
            result['events'] = [
                {'date': it['date'], 'title': it['title'], 'direction': '中性', 'significance': '中', 'summary': ''}
                for it in items[:20]
            ]

    cache_set(tl_cache_key, result, 7200)
    return jsonify(result)


# ── Policy Calendar ───────────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/calendar')
@safe_route(fallback_data={'events': []})
def policy_calendar():
    """Get upcoming policy events.
    Query params: days_ahead (default 30)"""
    days_ahead = min(int(request.args.get('days_ahead', 30)), 90)
    from services.policy_calendar import get_upcoming_events
    events = get_upcoming_events(days_ahead)
    return jsonify({'events': events, 'days_ahead': days_ahead})


@gov_news_bp.route('/api/cn/policy/calendar/preview', methods=['POST'])
@safe_route()
def policy_calendar_preview():
    """AI preview for an upcoming event.
    Body JSON: { event_name }"""
    data = request.get_json(silent=True) or {}
    event_name = data.get('event_name', '').strip()
    if not event_name:
        return jsonify({'error': '缺少event_name参数'}), 400
    from services.policy_calendar import get_event_preview
    result = get_event_preview(event_name)
    return jsonify(result)


# ── Policy Scoring ────────────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/score', methods=['POST'])
@safe_route()
def policy_score():
    """Score a policy article's strength (0-100, 5 dimensions).
    Body JSON: { title, content?, source?, category?, mode: 'fast'|'deep' }
    Returns: { total, grade, mode, dimensions: [{name, score, max, reasoning}] }"""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()
    source = data.get('source', '')
    category = data.get('category', '')
    mode = data.get('mode', 'fast')

    if not title:
        return jsonify({'error': '缺少title参数'}), 400

    # Cache by content hash + mode
    import hashlib
    score_hash = hashlib.md5((title + content[:500] + mode).encode()).hexdigest()
    score_cache_key = f'cn:policy:score:{score_hash}'
    cached = cache_get(score_cache_key)
    if cached:
        return jsonify(cached)

    from services.policy_scoring import score_policy_fast, score_policy_deep
    if mode == 'deep':
        result = score_policy_deep(title, content, source, category)
    else:
        result = score_policy_fast(title, content, source, category)

    cache_set(score_cache_key, result, 7200)  # 2h cache
    return jsonify(result)


# ── Policy Impact Chain ───────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/impact-chain', methods=['POST'])
@safe_route()
def policy_impact_chain():
    """Build a causal impact chain for a policy article.
    Body JSON: { title, content? }
    Returns causal chain, related policies, impacted sectors, timeline."""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title:
        return jsonify({'error': '缺少title参数'}), 400

    from services.policy_chains import build_impact_chain
    result = build_impact_chain(title, content)
    return jsonify(result)


# ── Policy Transmission Chain (DAG) ──────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/transmission-chain', methods=['POST'])
@safe_route()
def policy_transmission_chain():
    """Build a 5-level DAG transmission chain for a policy.
    Body JSON: { title, content? }
    Returns: { nodes, edges, summary }"""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title:
        return jsonify({'error': '缺少title参数'}), 400

    from services.policy_chains import build_transmission_chain
    result = build_transmission_chain(title, content)
    return jsonify(result)


# ── Signal Tracker ───────────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/signal-tracker')
@safe_route(fallback_data={'groups': [], 'emerging': []})
def policy_signal_tracker():
    """Get keyword frequency trends for tracked policy terms.
    Query params: days_back (default 90, max 180)"""
    days_back = min(int(request.args.get('days_back', 90)), 180)
    from services.policy_signal_tracker import compute_keyword_trends
    result = compute_keyword_trends(days_back)
    return jsonify(result)


# ── Policy Flash ─────────────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/flash')
@safe_route(fallback_data={'flashes': []})
def policy_flash():
    """Get recent policy flash alerts (breaking news).
    Query params: limit (default 20)"""
    limit = min(int(request.args.get('limit', 20)), 50)
    from services.report_scheduler import get_policy_flashes
    flashes = get_policy_flashes(limit)
    return jsonify({'flashes': flashes, 'total': len(flashes)})


# ── Sector Impact Matrix ─────────────────────────────────────────────────────

@gov_news_bp.route('/api/cn/policy/sector-matrix')
@safe_route(fallback_data={'sectors': []})
def policy_sector_matrix():
    """Aggregated sector impact heatmap from today's policies.
    Returns: { sectors: [{name, impact_score, direction, policy_count, top_policies}] }"""
    cached = cache_get('cn:policy:sector-matrix')
    if cached:
        return jsonify(cached)

    from services.cn_entity_registry import find_entities_in_text

    # Get today's news from cache or live crawl
    news_data = cache_get('cn:gov-news')
    if not news_data:
        try:
            news_data = get_gov_news()
        except Exception:
            return jsonify({'sectors': []})

    all_items = news_data.get('all', [])
    if not all_items:
        for cat_items in (news_data.get('categories', {}) or {}).values():
            all_items.extend(cat_items)

    if not all_items:
        return jsonify({'sectors': []})

    # Extract entities from each item, group by sector
    sector_policies: dict = {}  # sector_name → [titles]
    for item in all_items[:80]:
        title = item.get('title', '')
        if not title:
            continue
        entities = find_entities_in_text(title, max_results=5)
        for ent in entities:
            if ent.get('type') == 'sector':
                name = ent['name']
                if name not in sector_policies:
                    sector_policies[name] = []
                if title not in sector_policies[name]:
                    sector_policies[name].append(title)

    if not sector_policies:
        result = {'sectors': [], 'timestamp': __import__('datetime').datetime.now().isoformat()}
        cache_set('cn:policy:sector-matrix', result, 1800)
        return jsonify(result)

    # AI score each sector
    sector_summary = '\n'.join([
        f"- {name} ({len(titles)}条): {'; '.join(titles[:3])}"
        for name, titles in sorted(sector_policies.items(), key=lambda x: -len(x[1]))[:15]
    ])

    prompt = f"""根据今天的政策新闻，评估以下板块受到的综合影响。

今日政策与板块关联：
{sector_summary}

请为每个板块打分（-100到+100，正为利好负为利空），并给出一句话理由。
以JSON数组格式输出（不要markdown代码块）：
[
  {{"name": "板块名", "impact_score": 30, "direction": "利好/利空/中性", "reasoning": "一句话原因"}}
]"""

    sectors_result = []
    try:
        result_text = call_ai(
            prompt,
            system_prompt='你是政策对板块影响分析专家。严格按JSON数组格式输出。',
            max_tokens=1500,
        )
        if result_text:
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            parsed = json.loads(cleaned.strip())
            if isinstance(parsed, list):
                for item in parsed:
                    name = item.get('name', '')
                    if name in sector_policies:
                        item['policy_count'] = len(sector_policies[name])
                        item['top_policies'] = sector_policies[name][:3]
                        sectors_result.append(item)
    except Exception as e:
        logger.warning(f'Sector matrix AI failed: {e}')

    # Fallback: if AI failed, return basic counts
    if not sectors_result:
        for name, titles in sorted(sector_policies.items(), key=lambda x: -len(x[1]))[:15]:
            sectors_result.append({
                'name': name,
                'impact_score': 0,
                'direction': '中性',
                'policy_count': len(titles),
                'top_policies': titles[:3],
                'reasoning': '',
            })

    # Sort by absolute impact score
    sectors_result.sort(key=lambda x: abs(x.get('impact_score', 0)), reverse=True)

    result = {
        'sectors': sectors_result,
        'total_policies': len(all_items),
        'timestamp': __import__('datetime').datetime.now().isoformat(),
    }
    cache_set('cn:policy:sector-matrix', result, 1800)
    return jsonify(result)


# ── AI analysis & chat for individual policy articles ─────────────────────────

@gov_news_bp.route('/api/cn/policy/analyze', methods=['POST'])
@safe_route()
def policy_analyze():
    """AI-analyze a single policy article.
    Body JSON: { title, content, source?, category?, url? }
    Returns structured analysis JSON."""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title:
        return jsonify({'error': '缺少title参数'}), 400
    if len(content) < 30:
        return jsonify({'error': '文章内容太短，无法分析'}), 400

    # Cache by content hash
    import hashlib
    content_hash = hashlib.md5((title + content[:500]).encode()).hexdigest()
    cache_key = f'cn:policy:analysis:{content_hash}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    source = data.get('source', '')
    category = data.get('category', '')

    prompt = f"""请对以下政策/新闻文章进行结构化分析，以JSON格式输出：

文章标题：{title}
来源：{source}
分类：{category}

文章内容：
{content[:8000]}

请严格按以下JSON格式输出（不要添加markdown代码块标记）：
{{
  "summary": "100字以内的政策/新闻摘要",
  "keyPoints": ["核心要点1", "核心要点2", "核心要点3"],
  "marketImpact": "对A股/债券/汇率市场的影响分析(100字以内)",
  "sectors": ["受益/受损板块1", "受益/受损板块2"],
  "risks": ["潜在风险或不确定性1", "潜在风险或不确定性2"],
  "investmentAdvice": "基于该政策的投资建议(80字以内)",
  "policyDirection": "偏紧/中性/偏松/利好/利空/中性偏多/中性偏空",
  "causalChain": [
    {{"cause": "政策出台原因/背景", "effect": "直接影响/市场反应", "timeframe": "短期/中期/长期"}}
  ],
  "relatedPolicies": ["近期相关的政策名称1", "近期相关的政策名称2"],
  "policySignalStrength": "强信号/中等信号/弱信号（判断该政策对市场的信号强度）",
  "executive_impact": {{
    "ceo": "CEO视角：该政策对企业整体战略和资源配置的影响(1-2句，含具体建议)",
    "cmo": "CMO视角：该政策对市场格局、客户和渠道的影响(1-2句，含市场数据)",
    "cfo": "CFO视角：该政策对财务、融资和成本的影响(1-2句，含量化数字)",
    "cso": "CSO视角：该政策对竞争格局和长期战略定位的影响(1-2句，含竞对分析)"
  }},
  "time_impact": {{
    "near_term": "近期(0-3个月)影响：直接冲击+需要立即采取的行动",
    "mid_term": "中期(3-12个月)影响：传导效应+需要启动的部署",
    "long_term": "远期(1年以上)影响：结构性变化+战略布局方向"
  }}
}}"""

    result_text = call_ai(
        prompt,
        system_prompt='你是一位资深中国宏观政策分析师，擅长解读政府政策对金融市场的影响。请以严格JSON格式输出分析结果。executive_impact必须包含ceo/cmo/cfo/cso四个角色视角，time_impact必须包含near_term/mid_term/long_term三个时间维度。',
        max_tokens=2500,
    )

    if not result_text:
        return jsonify({'error': 'AI分析失败，请稍后重试'}), 500

    # Parse JSON from AI response
    try:
        # Strip markdown code block markers if present
        cleaned = result_text.strip()
        if cleaned.startswith('```'):
            cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        result = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        # Fallback: wrap raw text as summary
        result = {'summary': result_text[:500], 'keyPoints': [], 'marketImpact': '', 'sectors': [], 'risks': [], 'investmentAdvice': '', 'policyDirection': '中性'}

    cache_set(cache_key, result, 3600)  # 1h cache
    return jsonify(result)


@gov_news_bp.route('/api/cn/policy/compare', methods=['POST'])
@safe_route()
def policy_compare():
    """Cross-year policy comparison tool.
    Step 1 (search): POST { title, keywords? } → returns related policies grouped by year.
    Step 2 (compare): POST { title, content, compare_items: [{title, url, date}] } → AI comparison.
    """
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()
    compare_items = data.get('compare_items', [])

    if not title:
        return jsonify({'error': '缺少title参数'}), 400

    # Step 2: Generate AI comparison between current article and selected items
    if compare_items and content:
        return _do_compare(title, content, compare_items)

    # Step 1: Search for related policies
    user_keywords = data.get('keywords', [])
    exclude_url = data.get('url', '')

    # Strategy 0: Use AI to extract domain keywords from title (always, for better recall)
    # This is fast (~1s) and dramatically improves search quality
    ai_keywords = []
    if not user_keywords:
        ai_keywords = _ai_extract_search_keywords(title)

    # Combine: user keywords first, then AI keywords, then title-based extraction
    title_keywords = _extract_policy_keywords(title)
    keywords = user_keywords or (ai_keywords + [k for k in title_keywords if k not in ai_keywords])
    keywords = keywords[:8]  # cap at 8 keywords

    # Strategy 1: MySQL search with all keywords
    related = policy_store.search_related_policies(
        keywords, exclude_url=exclude_url, limit=60,
    )

    # Strategy 2: Also search live crawled data (always, not just when MySQL is sparse)
    live_results = _search_live_crawl(keywords, exclude_url)
    seen_urls = {it['url'] for it in related}
    for it in live_results:
        if it['url'] not in seen_urls and it['url'] != exclude_url:
            seen_urls.add(it['url'])
            related.append(it)

    # Strategy 3: If still few results, try broader keywords (2-char bigrams)
    if len(related) < 5 and len(title) >= 4:
        broader_kws = _extract_bigrams(title)
        if broader_kws:
            more = policy_store.search_related_policies(
                broader_kws, exclude_url=exclude_url, limit=30,
            )
            for it in more:
                if it['url'] not in seen_urls:
                    seen_urls.add(it['url'])
                    related.append(it)
            more_live = _search_live_crawl(broader_kws, exclude_url)
            for it in more_live:
                if it['url'] not in seen_urls:
                    seen_urls.add(it['url'])
                    related.append(it)
            keywords = keywords + [k for k in broader_kws if k not in keywords]

    # Strategy 4: If still sparse, ask AI for full feedback + alternative keywords
    ai_suggestion = None
    if len(related) < 3:
        ai_suggestion = _ai_suggest_related(title, keywords)
        if ai_suggestion and ai_suggestion.get('suggested_keywords'):
            ai_kws = ai_suggestion['suggested_keywords']
            more = policy_store.search_related_policies(
                ai_kws, exclude_url=exclude_url, limit=30,
            )
            for it in more:
                if it['url'] not in seen_urls:
                    seen_urls.add(it['url'])
                    related.append(it)
            more_live = _search_live_crawl(ai_kws, exclude_url)
            for it in more_live:
                if it['url'] not in seen_urls:
                    seen_urls.add(it['url'])
                    related.append(it)
            keywords = keywords + [k for k in ai_kws if k not in keywords]

    # Sort by date descending
    related.sort(key=lambda x: x.get('date', ''), reverse=True)

    # Group by year
    by_year: dict = {}
    for item in related:
        year = item.get('date', '')[:4] or '未知'
        if year not in by_year:
            by_year[year] = []
        by_year[year].append(item)

    result = {
        'keywords': keywords,
        'related': related,
        'by_year': by_year,
        'total': len(related),
    }

    # Add AI feedback when results are sparse
    if ai_suggestion:
        result['ai_feedback'] = ai_suggestion.get('feedback', '')
        result['ai_suggested_keywords'] = ai_suggestion.get('suggested_keywords', [])

    return jsonify(result)


def _ai_extract_search_keywords(title: str) -> list:
    """Use AI to quickly extract the best search keywords from a policy title.
    Returns a list of 3-5 keywords optimized for LIKE-based SQL search."""
    import json as _json
    prompt = f"""从政策标题中提取最佳搜索关键词，用于在数据库中查找相关政策。

标题：《{title}》

要求：
- 提取3-5个关键词，每个2-6个字
- 关键词应是政策的核心主题和领域（如"货币政策""房地产""金融监管"）
- 不要提取通用动词（如"加强""推进""关于"）
- 返回JSON数组格式，如 ["关键词1", "关键词2", "关键词3"]"""

    try:
        result = call_ai(prompt, system_prompt='你是中国政策分析专家。只返回JSON数组，不要其他内容。', max_tokens=200)
        if not result:
            return []
        result = result.strip()
        if '```' in result:
            result = result.split('```')[1]
            if result.startswith('json'):
                result = result[4:]
        # Find the JSON array
        start = result.find('[')
        end = result.rfind(']')
        if start >= 0 and end > start:
            result = result[start:end+1]
        parsed = _json.loads(result)
        if isinstance(parsed, list):
            return [kw for kw in parsed if isinstance(kw, str) and 2 <= len(kw) <= 15][:5]
    except Exception as e:
        logger.warning(f'AI extract keywords failed: {e}')
    return []


def _ai_suggest_related(title: str, tried_keywords: list) -> dict:
    """Use AI to suggest better search keywords and give feedback when search fails."""
    import json as _json
    prompt = f"""用户正在查看政策文章《{title}》，想要找到相关的历史政策进行跨年对比。

当前搜索关键词 {tried_keywords} 在数据库中未找到足够的相关文章。

请帮助分析：
1. 这篇文章属于什么政策领域？
2. 历史上有哪些相关的政策文件或报告可以用来对比？
3. 建议使用哪些更好的搜索关键词来查找相关历史政策？

请严格按以下JSON格式返回（不要其他内容）：
{{
  "feedback": "简短说明这篇文章的政策领域、可对比的历史政策方向（50字以内）",
  "suggested_keywords": ["关键词1", "关键词2", "关键词3"],
  "related_policy_types": ["相关政策类型1", "相关政策类型2"]
}}"""

    try:
        result = call_ai(prompt, system_prompt='你是中国宏观政策专家。', max_tokens=500)
        if not result:
            return {}
        # Parse JSON from AI response
        result = result.strip()
        # Handle markdown code blocks
        if '```' in result:
            result = result.split('```')[1]
            if result.startswith('json'):
                result = result[4:]
        parsed = _json.loads(result)
        # Validate structure
        if isinstance(parsed, dict) and 'suggested_keywords' in parsed:
            # Filter keywords
            parsed['suggested_keywords'] = [
                kw for kw in parsed['suggested_keywords']
                if isinstance(kw, str) and 2 <= len(kw) <= 15
            ][:5]
            return parsed
    except Exception as e:
        logger.warning(f'AI suggest related failed: {e}')
    return {}


def _search_live_crawl(keywords: list, exclude_url: str = '') -> list:
    """Search through cached/live crawled gov news data for matching titles.
    Uses scoring: items matching more keywords rank higher."""
    # Try cached data first
    cached = cache_get('cn:gov-news')
    if not cached:
        try:
            cached = get_gov_news()
        except Exception:
            return []

    all_items = []
    for cat, items in (cached or {}).get('categories', {}).items():
        all_items.extend(items)

    scored = []
    for item in all_items:
        item_title = item.get('title', '')
        item_url = item.get('url', '')
        if not item_title or item_url == exclude_url:
            continue
        # Score: count how many keywords match
        score = 0
        for kw in keywords:
            if len(kw) >= 2 and kw in item_title:
                score += len(kw)  # longer keyword matches are worth more
        if score > 0:
            scored.append((score, item))

    # Sort by score descending
    scored.sort(key=lambda x: x[0], reverse=True)
    return [it for _, it in scored[:40]]


def _extract_policy_keywords(title: str) -> list:
    """Extract searchable keywords from a policy title.
    Strategy: remove noise words from within the string, then split on gaps."""
    import re

    # Noise words: function words, common verbs, particles
    noise_words = [
        '关于', '有关', '进一步', '若干', '部分', '以及', '切实',
        '全面', '深入', '积极', '稳步', '不断', '大力', '认真', '着力',
        '加强', '推进', '深化', '优化', '完善', '促进', '推动', '加快',
        '做好', '开展', '组织', '保障', '落实', '贯彻', '实施', '执行',
        '印发', '发布', '公布', '批复', '下达', '转发', '通报',
        '通知', '意见', '方案', '规定', '办法', '措施', '细则',
        '下调', '上调', '提高', '降低', '扩大', '缩减', '调整',
        '出台', '推出', '发出', '提出', '启动', '开始', '继续',
        '主持', '召开', '讨论', '通过', '审议', '研究', '部署',
        '的', '了', '和', '在', '中', '等', '与', '及', '为', '将', '好', '新',
        '被写入', '写入', '重视', '正被', '我们',
        '亿元', '万元', '百分点', '小时前', '分钟前',
        '前两个月', '前三个月', '上半年', '下半年', '一季度',
    ]

    # Step 1: Clean title — remove year, numbers, punctuation, timestamps
    clean = re.sub(r'20\d{2}年度?', '', title)
    clean = re.sub(r'第?\d+[号期届次版]', '', clean)  # Remove 第X号/期
    clean = re.sub(r'\d+\.?\d*[%个百万亿元天月年]?', ' ', clean)  # Remove numbers with units
    clean = re.sub(r'\d+[小时分钟秒前]+前?', '', clean)  # Remove timestamps like "663小时前"
    clean = re.sub(r'[，。、；：！？""''（）《》【】\[\]\s\u3000·—\-|]+', ' ', clean).strip()

    # Step 2: Remove noise words (replace with space), longest first
    for w in sorted(noise_words, key=len, reverse=True):
        clean = clean.replace(w, ' ')

    # Step 3: Split into parts and filter
    parts = [p.strip() for p in clean.split() if len(p.strip()) >= 2]

    # Deduplicate while preserving order
    seen = set()
    keywords = []
    for p in parts:
        if p not in seen:
            seen.add(p)
            keywords.append(p)

    # Step 4: If we only got one long keyword (>6 chars), try splitting it further
    # into meaningful 2-4 char segments using common domain terms
    if len(keywords) == 1 and len(keywords[0]) > 6:
        expanded = _split_long_keyword(keywords[0])
        if len(expanded) > 1:
            keywords = expanded

    return keywords[:6]


def _split_long_keyword(text: str) -> list:
    """Try to split a long Chinese keyword into meaningful segments
    using known financial/policy domain terms."""
    import re
    # Common domain terms (longest first for greedy matching)
    domain_terms = [
        '供给侧结构性改革', '存款准备金率', '房地产调控',
        '资本市场', '营商环境', '乡村振兴', '科技创新', '国民经济',
        '高质量发展', '新质生产力', '数字经济', '人工智能',
        '金融监管', '货币政策', '财政政策', '产业政策', '外汇管理',
        '知识产权', '社会保障', '生态环境', '新能源', '碳中和',
        '房地产', '证券', '银行', '保险', '基金', '期货', '债券',
        '减税降费', '降息', '降准', '利率', '汇率', '通胀',
        '出口', '进口', '外贸', '投资', '消费', '就业',
        '教育', '医疗', '养老', '住房', '环保', '能源',
        '国企改革', '民营经济', '小微企业', '制造业', '服务业',
        '央行', '财政部', '发改委', '商务部', '工信部',
        '再融资', '注册制', '退市', '融资', '上市',
        '稳增长', '防风险', '促改革', '惠民生',
        '政府工作报告', '五年规划', '经济工作会议',
    ]
    found = []
    remaining = text
    for term in sorted(domain_terms, key=len, reverse=True):
        if term in remaining:
            found.append(term)
            remaining = remaining.replace(term, ' ', 1)
    # Add remaining parts if meaningful
    for p in remaining.split():
        if len(p) >= 2 and p not in found:
            found.append(p)
    return found if found else [text]


def _extract_bigrams(title: str) -> list:
    """Extract 2-character bigrams from title for broader matching."""
    import re
    # Clean title
    clean = re.sub(r'[，。、；：！？""''（）《》【】\[\]\s\u3000·—\-20\d{2}年度?]+', '', title)
    # Common noise chars to skip
    skip = set('关于的了和在中等有关进一步通知意见方案若干印发发布公布批复规定实施工作全面推进加强深入贯彻落实做好开展完善促进推动优化加快深化')
    bigrams = []
    seen = set()
    for i in range(len(clean) - 1):
        bg = clean[i:i+2]
        if bg[0] not in skip and bg[1] not in skip and bg not in seen:
            seen.add(bg)
            bigrams.append(bg)
    return bigrams[:5]


def _do_compare(title: str, content: str, compare_items: list) -> 'Response':
    """Generate AI comparison between current article and selected related policies."""
    import hashlib

    # Fetch content for comparison items
    comp_contents = []
    for item in compare_items[:3]:  # max 3 comparison targets
        comp_url = item.get('url', '')
        comp_title = item.get('title', '')
        comp_date = item.get('date', '')

        # Try to fetch article content
        article_data = None
        if comp_url:
            from services.article_fetcher import fetch_article, can_fetch
            if can_fetch(comp_url):
                article_data = fetch_article(comp_url)

        comp_text = ''
        if article_data and article_data.get('content'):
            from bs4 import BeautifulSoup
            comp_text = BeautifulSoup(article_data['content'], 'html.parser').get_text()[:4000]

        comp_contents.append({
            'title': comp_title,
            'date': comp_date,
            'content': comp_text,
            'has_content': bool(comp_text),
        })

    # Build comparison prompt
    current_summary = content[:4000]
    comp_sections = []
    for i, cc in enumerate(comp_contents):
        if cc['has_content']:
            comp_sections.append(f"【对比文件{i+1}】标题：{cc['title']}\n日期：{cc['date']}\n内容摘要：{cc['content'][:3000]}")
        else:
            comp_sections.append(f"【对比文件{i+1}】标题：{cc['title']}\n日期：{cc['date']}\n（未能获取正文，仅根据标题对比）")

    comp_text = '\n\n'.join(comp_sections)

    # Cache check
    cache_parts = title + '|' + '|'.join(c['title'] for c in comp_contents)
    cache_hash = hashlib.md5(cache_parts.encode()).hexdigest()
    cache_key = f'cn:policy:compare:{cache_hash}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    prompt = f"""请对以下政策文件进行详细的跨期对比分析：

【当前文件】标题：{title}
内容：{current_summary}

{comp_text}

请按以下JSON格式输出详细对比分析结果（不要添加markdown代码块标记）：
{{
  "summary": "整体对比概述，阐述政策演变脉络和核心变化（200-300字）",
  "dimensions": [
    {{
      "name": "维度名称（如政策基调、重点领域、财政政策、货币政策、产业政策、具体措施、量化指标等）",
      "current": "当前文件在该维度的具体表述和关键措辞",
      "previous": "对比文件在该维度的具体表述和关键措辞",
      "change": "变化方向（新增/加强/减弱/删除/不变/调整/升级/细化）",
      "analysis": "详细的变化分析，解释措辞变化背后的政策信号（80-150字）"
    }}
  ],
  "newAdditions": ["当前文件新增的重要内容（带具体引述）"],
  "removals": ["相比之前删除或不再提及的重要内容（带具体引述）"],
  "toneShift": "整体基调变化描述，包括具体措辞对比（如从'稳健'转向'积极'，从'适当'变为'大力'）",
  "marketImplication": "对A股、债券、汇率等金融市场的具体影响分析（200字以内）",
  "keyTakeaway": "最关键的变化要点总结"
}}

注意：
- dimensions 至少分析 5-8 个维度，覆盖宏观政策各方面
- 每个维度的 current 和 previous 应引用原文关键表述
- analysis 要解释措辞变化的深层含义"""

    result_text = call_ai(
        prompt,
        system_prompt='你是一位资深中国政策研究专家，擅长政策文件的跨年对比分析，能精准捕捉措辞变化、政策信号和重点转移。请以严格JSON格式输出。',
        max_tokens=6000,
    )

    if not result_text:
        return jsonify({'error': 'AI对比分析失败，请稍后重试'}), 500

    try:
        cleaned = result_text.strip()
        if cleaned.startswith('```'):
            cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        result = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        result = {'summary': result_text[:1000], 'dimensions': [], 'newAdditions': [], 'removals': [], 'toneShift': '', 'marketImplication': '', 'keyTakeaway': ''}

    result['compare_items'] = [{'title': c['title'], 'date': c['date'], 'has_content': c['has_content']} for c in comp_contents]
    cache_set(cache_key, result, 3600)
    return jsonify(result)


@gov_news_bp.route('/api/cn/policy/chat', methods=['POST'])
@safe_route()
def policy_chat():
    """Chat with AI about a specific policy article.
    Body JSON: { title, content, question, history? }
    Returns { answer }."""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()
    question = data.get('question', '').strip()
    history = data.get('history', [])

    if not question:
        return jsonify({'error': '缺少question参数'}), 400

    # Build context from article
    article_ctx = f"文章标题：{title}\n\n" if title else ''
    if content:
        article_ctx += f"文章内容：\n{content[:6000]}\n"

    # Build conversation history
    history_text = ''
    if history:
        for msg in history[-6:]:
            role_label = '用户' if msg.get('role') == 'user' else 'AI'
            history_text += f'{role_label}: {msg.get("content", "")}\n'

    # Detect if user wants detailed/long-form analysis
    deep_keywords = ['对比', '逐句', '逐条', '逐字', '比较', '异同', '变化']
    detail_keywords = ['详细', '全面', '完整', '报告', '深度', '深入', '展开']
    wants_compare = any(kw in question for kw in deep_keywords)
    wants_detail = any(kw in question for kw in detail_keywords)

    if wants_compare:
        tok_limit = 8000
        length_hint = '请进行详细、全面的逐条对比分析，可以使用表格或分点方式呈现，不限字数，务必覆盖所有要点。'
    elif wants_detail:
        tok_limit = 4000
        length_hint = '请尽量详细、全面地回答，可以分段分点阐述，不限字数。'
    else:
        tok_limit = 2000
        length_hint = '回答要有数据支撑，条理清晰。'

    prompt = f"""{article_ctx}
{f'对话历史：{chr(10)}{history_text}{chr(10)}' if history_text else ''}用户提问：{question}

请基于上述政策/新闻文章内容，专业、客观地回答用户问题。{length_hint}"""

    answer = call_ai(
        prompt,
        system_prompt='你是一位资深中国宏观政策分析师，擅长解读政策文件和官方新闻对经济和金融市场的影响。请用中文回答。',
        max_tokens=tok_limit,
    )

    if not answer:
        return jsonify({'answer': '抱歉，暂时无法回答，请稍后重试。'})

    return jsonify({'answer': answer})


# ── Helper ────────────────────────────────────────────────────────────────────

def _auto_store(data: dict):
    """Store all crawled items to MySQL (fire-and-forget).
    Also generates policy flash alerts for high-importance new items."""
    try:
        all_items = []
        for cat, items in data.get('categories', {}).items():
            all_items.extend(items)
        # Dedup by url
        seen = set()
        unique = []
        for it in all_items:
            url = it.get('url', '')
            if url and url not in seen:
                seen.add(url)
                unique.append(it)
        if unique:
            new_count = policy_store.store_items(unique)
            # Generate flash alerts for newly stored items
            if new_count > 0:
                try:
                    from services.report_scheduler import build_policy_flash
                    build_policy_flash(unique)
                except Exception as fe:
                    logger.warning(f'[auto-store] Flash generation error: {fe}')
                # Evaluate items for user-profile-based alerts (Phase 3)
                try:
                    from services.alert_engine import evaluate_batch
                    evaluate_batch(unique)
                except Exception as ae:
                    logger.warning(f'[auto-store] Alert evaluation error: {ae}')
    except Exception as e:
        logger.warning(f'[auto-store] Error: {e}')
