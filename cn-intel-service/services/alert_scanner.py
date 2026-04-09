"""Background alert scanner — AI-powered relevance detection.

Uses AI (not keyword matching) to determine if news/policy items are relevant
to a user's enterprise. Scans both `news` table and `policy_news` table.

Flow:
  1. Collect recent news items (policy + general)
  2. Group into batches of ~30 titles
  3. Send each batch to AI with company profile
  4. AI identifies relevant items + impact level + reason
  5. Generate alerts from AI results
"""

import json
import hashlib
import logging
import threading
import time
import traceback
from datetime import datetime, date, timedelta

logger = logging.getLogger('cn-intel.alert-scanner')

_SCAN_INTERVAL = 900  # 15 minutes
_BATCH_SIZE = 30      # titles per AI call
_last_scan_ts = None
_scanner_running = False

# Redis cache for AI analysis results (avoid re-analyzing same items)
_AI_ANALYSIS_CACHE_PREFIX = 'cn:alert-ai:'
_AI_ANALYSIS_CACHE_TTL = 86400  # 24h


def start_alert_scanner(app):
    """Start background alert scanner thread. Called from create_app()."""
    global _scanner_running
    if _scanner_running:
        return
    _scanner_running = True

    def _loop():
        global _last_scan_ts
        # Wait for services to initialize
        time.sleep(10)
        logger.warning('[alert-scanner] Background scanner started')

        while True:
            try:
                with app.app_context():
                    _run_scan(app)
                _last_scan_ts = datetime.now()
            except Exception as e:
                logger.warning(f'[alert-scanner] Scan error: {e}\n{traceback.format_exc()}')
            time.sleep(_SCAN_INTERVAL)

    t = threading.Thread(target=_loop, daemon=True, name='alert-scanner')
    t.start()


def run_scan_now(app):
    """Trigger immediate scan (e.g., after profile creation)."""
    try:
        with app.app_context():
            _run_scan(app)
    except Exception as e:
        logger.warning(f'[alert-scanner] Immediate scan error: {e}')


def _run_scan(app):
    """Core scan: collect items → AI batch analysis → dispatch alerts."""
    from services.user_profile import get_all_profiles
    from services.alert_engine import dispatch_alert

    profiles = get_all_profiles()
    if not profiles:
        logger.warning('[alert-scanner] No user profiles, skipping scan')
        return

    # Determine scan window
    global _last_scan_ts
    if _last_scan_ts:
        days_back = 1
    else:
        days_back = 3  # First scan warm-up

    # Collect items from both sources
    items = _collect_items(app, days_back)
    if not items:
        logger.warning('[alert-scanner] No items to scan')
        return

    # For each user profile, run AI batch analysis
    total_alerts = 0
    for profile in profiles:
        user_id = profile.get('user_id', '')
        company = profile.get('company_name', '')
        if not user_id or not company:
            continue

        # Filter out already-analyzed items (cached)
        new_items = _filter_uncached(items, user_id)
        if not new_items and not _last_scan_ts:
            # First scan: also include cached items
            new_items = items

        if not new_items:
            logger.warning(f'[alert-scanner] All items cached for {user_id[:8]}..., skipping')
            continue

        # AI batch analysis
        relevant = _ai_batch_analyze(new_items, profile)

        # Dispatch alerts
        for r in relevant:
            alert = _build_alert(r, profile)
            if alert:
                dispatch_alert(alert)
                total_alerts += 1

    logger.warning(f'[alert-scanner] Scan complete: {len(items)} items, '
                   f'{len(profiles)} profiles, {total_alerts} alerts dispatched')


def _collect_items(app, days_back: int) -> list:
    """Collect and deduplicate items from both news sources."""
    all_items = []

    # Source 1: policy_news table
    try:
        from services import policy_store
        start = (date.today() - timedelta(days=days_back)).isoformat()
        end = date.today().isoformat()
        policy_items = policy_store.get_items_by_date_range(start, end, limit=500)
        if len(policy_items) < 50:
            logger.warning(f'[alert-scanner] policy_news sparse ({len(policy_items)}), triggering crawl')
            _trigger_gov_news_crawl(app)
            policy_items = policy_store.get_items_by_date_range(start, end, limit=500)
        for it in policy_items:
            it['_source_type'] = 'policy'
        all_items.extend(policy_items)
    except Exception as e:
        logger.warning(f'[alert-scanner] Policy store query failed: {e}')

    # Source 2: news table (general DB news)
    try:
        db_items = _get_recent_db_news(days_back)
        for it in db_items:
            it['_source_type'] = 'news'
        all_items.extend(db_items)
    except Exception as e:
        logger.warning(f'[alert-scanner] DB news query failed: {e}')

    # Dedup by URL + normalize
    seen_urls = set()
    unique = []
    for it in all_items:
        title = it.get('title', '') or it.get('info_title', '')
        url = it.get('url', '') or it.get('link_address', '')
        if not title:
            continue
        if url and url in seen_urls:
            continue
        if url:
            seen_urls.add(url)
        unique.append({
            'title': title,
            'url': url,
            'source': it.get('source_name', '') or it.get('source', '') or it.get('media', ''),
            'source_key': it.get('source_key', ''),
            'category': it.get('category', ''),
            '_source_type': it.get('_source_type', 'news'),
        })

    return unique


def _filter_uncached(items: list, user_id: str) -> list:
    """Filter out items that were already AI-analyzed for this user."""
    try:
        from flask import current_app
        r = current_app.redis
        if not r:
            return items
        uncached = []
        for it in items:
            cache_key = _ai_cache_key(it['url'] or it['title'], user_id)
            if not r.exists(cache_key):
                uncached.append(it)
        return uncached
    except Exception:
        return items


def _ai_cache_key(identifier: str, user_id: str) -> str:
    h = hashlib.md5(f'{user_id}:{identifier}'.encode()).hexdigest()[:16]
    return f'{_AI_ANALYSIS_CACHE_PREFIX}{h}'


def _ai_batch_analyze(items: list, profile: dict) -> list:
    """Use AI to batch-analyze news items for relevance to a company profile.
    Returns list of relevant items with impact analysis."""
    from services.ai_analysis import call_ai

    company = profile.get('company_name', '')
    industries = ', '.join(profile.get('industries', []))
    sectors = ', '.join(profile.get('tracked_sectors', [])[:6])
    keywords = ', '.join(profile.get('tracked_keywords', [])[:8])
    user_id = profile.get('user_id', '')

    all_relevant = []

    # Process in batches
    for batch_start in range(0, len(items), _BATCH_SIZE):
        batch = items[batch_start:batch_start + _BATCH_SIZE]

        # Build numbered title list
        title_list = '\n'.join(f'{i+1}. [{it["source"] or it["category"]}] {it["title"][:200]}'
                               for i, it in enumerate(batch))

        prompt = f"""你是企业情报分析师。以下是近期新闻/政策标题列表，请找出与目标企业**相关**的条目。

## 目标企业
- 企业名称: {company}
- 所属行业: {industries}
- 关注板块: {sectors}
- 关注关键词: {keywords}

## 新闻列表
{title_list}

## 要求
从上面{len(batch)}条新闻中，找出与该企业业务、行业、上下游、政策环境、竞争格局**有关**的条目。
注意：不要只看标题里有没有关键词，要从企业经营角度分析是否真正相关。
例如：药品管理法对医药IT企业有间接影响，消费补贴对消费行业企业有影响。

用JSON数组回答(只输出JSON，不要其他文字):
[{{"idx":序号,"tier":"FLASH或PRIORITY或ROUTINE","reason":"一句话说明对企业的影响(20字内)","impact":"positive或negative或neutral"}}]

分层标准:
- FLASH: 直接重大影响（如行业新法规、重大政策转向）
- PRIORITY: 间接但重要影响（如行业趋势、上下游变化）
- ROUTINE: 一般关注（如行业动态、竞品新闻）

如果没有相关条目，返回空数组 []"""

        try:
            result = call_ai(prompt,
                             system_prompt='你是精准的企业情报分析师。只选真正相关的条目，不要过度关联。',
                             max_tokens=1500)
            if not result:
                continue

            # Parse response
            text = result.strip()
            if '```' in text:
                start = text.find('[')
                end = text.rfind(']')
                if start >= 0 and end > start:
                    text = text[start:end + 1]
            elif not text.startswith('['):
                start = text.find('[')
                end = text.rfind(']')
                if start >= 0 and end > start:
                    text = text[start:end + 1]

            hits = json.loads(text)
            if not isinstance(hits, list):
                continue

            for hit in hits:
                idx = hit.get('idx', 0)
                if not isinstance(idx, int) or idx < 1 or idx > len(batch):
                    continue
                item = batch[idx - 1]
                all_relevant.append({
                    **item,
                    'tier': hit.get('tier', 'ROUTINE'),
                    'ai_reason': hit.get('reason', ''),
                    'ai_impact': hit.get('impact', 'neutral'),
                })

            # Cache analyzed items
            _cache_analysis(batch, hits, user_id)

        except json.JSONDecodeError as e:
            logger.warning(f'[alert-scanner] AI JSON parse error: {e}')
        except Exception as e:
            logger.warning(f'[alert-scanner] AI batch analysis error: {e}')

    logger.warning(f'[alert-scanner] AI analysis found {len(all_relevant)} relevant items '
                   f'from {len(items)} total')
    return all_relevant


def _cache_analysis(batch: list, hits: list, user_id: str):
    """Cache which items were analyzed (both relevant and irrelevant)."""
    try:
        from flask import current_app
        r = current_app.redis
        if not r:
            return
        hit_indices = {h.get('idx', 0) for h in hits}
        for i, it in enumerate(batch):
            cache_key = _ai_cache_key(it['url'] or it['title'], user_id)
            is_relevant = (i + 1) in hit_indices
            r.setex(cache_key, _AI_ANALYSIS_CACHE_TTL, '1' if is_relevant else '0')
    except Exception:
        pass


def _build_alert(item: dict, profile: dict) -> dict | None:
    """Build alert dict from AI-analyzed relevant item."""
    tier = item.get('tier', 'ROUTINE')
    if tier not in ('FLASH', 'PRIORITY', 'ROUTINE'):
        tier = 'ROUTINE'

    user_id = profile.get('user_id', '')
    title = item.get('title', '')
    url = item.get('url', '')
    reason = item.get('ai_reason', '')
    impact_dir = item.get('ai_impact', 'neutral')

    # Map impact direction to display
    impact_prefix = {'positive': '利好', 'negative': '利空', 'neutral': '关注'}
    display_reason = f'{impact_prefix.get(impact_dir, "关注")}: {reason}' if reason else '相关性匹配'

    # Map tier → impact_level for frontend display
    tier_to_level = {'FLASH': 'HIGH', 'PRIORITY': 'MEDIUM', 'ROUTINE': 'LOW'}

    return {
        'id': hashlib.md5(f'{user_id}:{url}:{tier}'.encode()).hexdigest()[:16],
        'user_id': user_id,
        'tier': tier,
        'title': title,
        'url': url,
        'score': {'FLASH': 90, 'PRIORITY': 70, 'ROUTINE': 50}.get(tier, 50),
        'source': item.get('source', ''),
        'source_key': item.get('source_key', ''),
        'category': item.get('category', ''),
        'match_reason': display_reason,
        'created_at': datetime.now().isoformat(),
        'read': False,
        'impact': {
            'direction': impact_dir,
            'summary': reason,
            'impact_level': tier_to_level.get(tier, 'MEDIUM'),
            'positive': [reason] if impact_dir == 'positive' else [],
            'negative': [reason] if impact_dir == 'negative' else [],
            'affected_sectors': [],
        } if reason else None,
    }


def _trigger_gov_news_crawl(app):
    """Trigger gov-news crawl + auto-store to populate policy_news table."""
    try:
        from services.gov_news_crawler import get_gov_news
        from services import policy_store

        data = get_gov_news()
        if not data:
            return

        all_items = []
        for cat, items in data.get('categories', {}).items():
            all_items.extend(items)
        seen = set()
        unique = []
        for it in all_items:
            url = it.get('url', '')
            if url and url not in seen:
                seen.add(url)
                unique.append(it)
        if unique:
            new_count = policy_store.store_items(unique)
            logger.warning(f'[alert-scanner] Crawled + stored {new_count} new policy items '
                           f'(total {len(unique)})')
    except Exception as e:
        logger.warning(f'[alert-scanner] Gov-news crawl failed: {e}')


def _get_recent_db_news(days_back: int) -> list:
    """Get recent news from the `news` table (type=0 综合新闻)."""
    import pymysql
    from services.db_pool import get_connection

    cutoff = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')
    conn = get_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                """SELECT id, info_title AS title, news_date, media AS source,
                          resume, emotion, link_address AS url
                   FROM news
                   WHERE type = '0' AND news_date >= %s
                   ORDER BY news_date DESC
                   LIMIT 200""",
                [cutoff],
            )
            return list(cur.fetchall())
    finally:
        conn.close()
