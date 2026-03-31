"""Three-tier alert engine (Crucix FLASH/PRIORITY/ROUTINE pattern).

| Tier     | Trigger                                    | Cooldown    | Daily Max |
|----------|--------------------------------------------|-------------|-----------|
| FLASH    | score>=80 + high-authority + urgent keyword | 30min/topic | 10        |
| PRIORITY | score>=60 + matches user industry + mood>20%| 2h/topic    | 30        |
| ROUTINE  | score>=40 + any profile keyword match       | 6h/topic    | 100       |

Alerts are stored in Redis lists (per-user inbox) and optionally
dispatched via SSE (PubSub) for FLASH-tier real-time pushes.
"""

import json
import hashlib
import logging
import time
from datetime import datetime, date

logger = logging.getLogger('cn-intel.alert-engine')

# Tier configuration
TIERS = {
    'FLASH': {'min_score': 80, 'cooldown_s': 1800, 'daily_max': 10, 'color': '#ef5350'},
    'PRIORITY': {'min_score': 60, 'cooldown_s': 7200, 'daily_max': 30, 'color': '#e8a838'},
    'ROUTINE': {'min_score': 40, 'cooldown_s': 21600, 'daily_max': 100, 'color': '#42a5f5'},
}

# High-authority sources that boost to FLASH
_FLASH_SOURCES = {'xinhua', 'people', 'gov', 'pboc', 'csrc', 'mof', 'ndrc', 'sc'}

# Urgent keywords that boost to FLASH
_FLASH_KEYWORDS = ['降息', '降准', '加息', '紧急', '重大', '突发', '暂停IPO',
                    '央行', '国务院常务会议', '全面降准', '定向降准']


def evaluate_item(item: dict, score: int, profiles: list) -> list:
    """Evaluate a single scored policy item against all profiles.
    Returns list of alert dicts to dispatch."""
    if score < 40:
        return []

    title = item.get('title', '')
    source_key = item.get('source_key', '')
    url = item.get('url', '')

    alerts = []
    for profile in profiles:
        user_id = profile.get('user_id', '')
        if not user_id:
            continue

        tier = _classify_tier(item, score, profile)
        if not tier:
            continue

        alert_min = profile.get('alert_min_score', 60)
        if score < alert_min and tier != 'FLASH':
            continue

        # Build alert
        alert = {
            'id': hashlib.md5(f'{user_id}:{url}:{tier}'.encode()).hexdigest()[:16],
            'user_id': user_id,
            'tier': tier,
            'title': title,
            'url': url,
            'score': score,
            'source': item.get('source', ''),
            'source_key': source_key,
            'category': item.get('category', ''),
            'match_reason': _get_match_reason(item, profile, tier),
            'created_at': datetime.now().isoformat(),
            'read': False,
            'impact': None,
        }

        # AI enterprise impact analysis for FLASH/PRIORITY (non-blocking)
        if tier in ('FLASH', 'PRIORITY'):
            try:
                impact = _analyze_enterprise_impact(item, profile)
                if impact:
                    alert['impact'] = impact
                    # Enhance match_reason with AI summary
                    summary = impact.get('summary', '')
                    if summary:
                        alert['match_reason'] = summary
            except Exception as e:
                logger.warning(f'[alert] Impact analysis error: {e}')

        alerts.append(alert)

    return alerts


def evaluate_batch(items: list, scored_items: list = None):
    """Evaluate a batch of items against all user profiles.
    Called from _auto_store() after new items are persisted."""
    from services.user_profile import get_all_profiles
    from services.policy_scoring import score_policy_fast

    profiles = get_all_profiles()
    if not profiles:
        return

    for item in items:
        # Get score (from pre-scored or compute fast)
        score = 0
        if scored_items:
            for si in scored_items:
                if si.get('url') == item.get('url'):
                    score = si.get('total_score', 0)
                    break
        if not score:
            result = score_policy_fast(item.get('title', ''), '')
            score = result.get('total_score', 0)

        alerts = evaluate_item(item, score, profiles)
        for alert in alerts:
            dispatch_alert(alert)


def dispatch_alert(alert: dict):
    """Store alert in user's Redis inbox and publish for SSE."""
    try:
        from flask import current_app
        r = current_app.redis
    except Exception:
        return

    if not r:
        return

    user_id = alert['user_id']
    tier = alert['tier']
    title = alert['title']
    today = date.today().isoformat()

    # Dedup check (semantic similarity via 2-gram)
    if _is_duplicate(r, user_id, tier, title):
        return

    # Rate limit check
    rate_key = f'cn:alerts:rate:{user_id}:{tier}:{today}'
    count = r.get(rate_key)
    daily_max = TIERS[tier]['daily_max']
    if count and int(count) >= daily_max:
        return

    # Store in inbox (Redis list, max 200 per user)
    inbox_key = f'cn:alerts:{user_id}'
    r.lpush(inbox_key, json.dumps(alert, ensure_ascii=False, default=str))
    r.ltrim(inbox_key, 0, 199)
    r.expire(inbox_key, 86400)

    # Increment rate counter
    r.incr(rate_key)
    r.expire(rate_key, 86400)

    # Update unread count
    unread_key = f'cn:alerts:unread:{user_id}'
    r.incr(unread_key)
    r.expire(unread_key, 86400)

    # Store dedup data (bigram set or exact-match flag)
    cooldown = TIERS[tier]['cooldown_s']
    _store_dedup(r, user_id, tier, title, cooldown)

    # Publish for SSE (FLASH only)
    if tier == 'FLASH':
        r.publish(f'cn:alerts:stream:{user_id}', json.dumps(alert, ensure_ascii=False, default=str))

    logger.warning(f'[alert] Dispatched {tier} to {user_id[:8]}...: {title[:40]}')


def get_user_alerts(user_id: str, tier: str = '', unread_only: bool = False,
                    limit: int = 50) -> list:
    """Get alerts from user's inbox."""
    try:
        from flask import current_app
        r = current_app.redis
    except Exception:
        return []

    if not r:
        return []

    inbox_key = f'cn:alerts:{user_id}'
    raw_items = r.lrange(inbox_key, 0, 199)
    alerts = []
    for raw in raw_items:
        try:
            alert = json.loads(raw)
            if tier and alert.get('tier') != tier:
                continue
            if unread_only and alert.get('read'):
                continue
            alerts.append(alert)
            if len(alerts) >= limit:
                break
        except Exception:
            continue
    return alerts


def mark_read(user_id: str, alert_ids: list):
    """Mark alerts as read."""
    try:
        from flask import current_app
        r = current_app.redis
    except Exception:
        return

    if not r:
        return

    inbox_key = f'cn:alerts:{user_id}'
    raw_items = r.lrange(inbox_key, 0, 199)
    id_set = set(alert_ids)
    marked = 0

    # Rebuild list with read flags
    updated = []
    for raw in raw_items:
        try:
            alert = json.loads(raw)
            if alert.get('id') in id_set:
                alert['read'] = True
                marked += 1
            updated.append(json.dumps(alert, ensure_ascii=False, default=str))
        except Exception:
            updated.append(raw)

    # Replace list
    if marked > 0:
        r.delete(inbox_key)
        for item in updated:
            r.rpush(inbox_key, item)
        r.expire(inbox_key, 86400)

        # Update unread count
        unread_key = f'cn:alerts:unread:{user_id}'
        current = int(r.get(unread_key) or 0)
        r.set(unread_key, max(0, current - marked))
        r.expire(unread_key, 86400)


def get_unread_count(user_id: str) -> int:
    """Get unread alert count for a user."""
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            return int(r.get(f'cn:alerts:unread:{user_id}') or 0)
    except Exception:
        pass
    return 0


def get_alert_stats(user_id: str, days: int = 7) -> dict:
    """Get alert statistics."""
    alerts = get_user_alerts(user_id, limit=200)
    stats = {'FLASH': 0, 'PRIORITY': 0, 'ROUTINE': 0, 'total': 0, 'unread': 0}
    for a in alerts:
        tier = a.get('tier', '')
        if tier in stats:
            stats[tier] += 1
        stats['total'] += 1
        if not a.get('read'):
            stats['unread'] += 1
    return stats


def _classify_tier(item: dict, score: int, profile: dict) -> str | None:
    """Determine alert tier for an item+profile pair."""
    title = item.get('title', '')
    source_key = item.get('source_key', '')

    # FLASH: high score + high authority + urgent keywords
    if score >= 80:
        is_high_auth = source_key in _FLASH_SOURCES
        has_urgent = any(kw in title for kw in _FLASH_KEYWORDS)
        if is_high_auth or has_urgent:
            return 'FLASH'

    # PRIORITY: moderate score + matches user industry
    if score >= 60:
        from services.relevance_scorer import score_relevance
        rel = score_relevance(item, profile)
        if rel >= 0.3:
            return 'PRIORITY'

    # ROUTINE: low score + any keyword match
    if score >= 40:
        from services.relevance_scorer import score_relevance
        rel = score_relevance(item, profile)
        if rel >= 0.1:
            return 'ROUTINE'

    return None


def _analyze_enterprise_impact(item: dict, profile: dict) -> dict | None:
    """Use AI to analyze how a policy impacts a specific enterprise.
    Only called for FLASH/PRIORITY tiers. Returns structured impact or None."""
    try:
        from flask import current_app
        r = current_app.redis
    except Exception:
        r = None

    title = item.get('title', '')
    url = item.get('url', '')
    user_id = profile.get('user_id', '')

    # Check Redis cache first
    if r:
        cache_key = f'cn:alert:impact:{hashlib.md5((url + user_id).encode()).hexdigest()[:16]}'
        cached = r.get(cache_key)
        if cached:
            try:
                return json.loads(cached)
            except Exception:
                pass

    # Build AI prompt
    industries = ', '.join(profile.get('industries', [])[:5]) or '未设置'
    sectors = ', '.join(profile.get('tracked_sectors', [])[:8]) or '未设置'
    stocks = ', '.join(profile.get('tracked_stocks', [])[:5]) or '未设置'
    company = profile.get('company_name', '') or '未设置'

    prompt = f"""分析以下政策/新闻对企业的具体影响：

政策标题: {title}
来源: {item.get('source', '')}

企业名称: {company}
所属行业: {industries}
关注板块: {sectors}
关注个股: {stocks}

用JSON回答(只输出JSON，不要其他文字):
{{"positive":["具体利好1","具体利好2"],"negative":["具体利空1"],"affected_sectors":["受影响板块"],"impact_level":"HIGH或MEDIUM或LOW","summary":"一句话影响摘要(30字内)"}}

要求:
- positive/negative列出对该企业的具体影响，每条15-25字
- 没有则填空数组[]
- impact_level根据对企业的实际影响程度判断
- summary必须点明对该企业是利好还是利空"""

    try:
        from services.ai_analysis import call_ai
        result = call_ai(prompt, system_prompt='你是企业政策影响分析师，精准分析政策对特定企业的正负面影响。', max_tokens=500)
        if not result:
            return None

        # Parse JSON from response
        text = result.strip()
        # Extract JSON if wrapped in markdown code block
        if '```' in text:
            start = text.find('{')
            end = text.rfind('}')
            if start >= 0 and end > start:
                text = text[start:end + 1]

        impact = json.loads(text)

        # Validate structure
        if not isinstance(impact.get('positive'), list):
            impact['positive'] = []
        if not isinstance(impact.get('negative'), list):
            impact['negative'] = []
        if impact.get('impact_level') not in ('HIGH', 'MEDIUM', 'LOW'):
            impact['impact_level'] = 'MEDIUM'
        if not impact.get('summary'):
            impact['summary'] = '影响待评估'

        # Cache in Redis (24h)
        if r:
            r.setex(cache_key, 86400, json.dumps(impact, ensure_ascii=False))

        logger.warning(f'[alert-impact] AI analysis for {user_id[:8]}...: {impact.get("summary", "")[:30]}')
        return impact

    except json.JSONDecodeError as e:
        logger.warning(f'[alert-impact] JSON parse error: {e}')
        return None
    except Exception as e:
        logger.warning(f'[alert-impact] AI call failed: {e}')
        return None


def _get_match_reason(item: dict, profile: dict, tier: str) -> str:
    """Generate human-readable match reason."""
    reasons = []
    title = item.get('title', '')

    if tier == 'FLASH':
        matched = [kw for kw in _FLASH_KEYWORDS if kw in title]
        if matched:
            reasons.append(f'关键词: {", ".join(matched[:3])}')
        if item.get('source_key') in _FLASH_SOURCES:
            reasons.append(f'高层来源: {item.get("source", "")}')

    industries = profile.get('industries', [])
    matched_ind = [ind for ind in industries if ind in title]
    if matched_ind:
        reasons.append(f'行业: {", ".join(matched_ind)}')

    keywords = profile.get('tracked_keywords', [])
    matched_kw = [kw for kw in keywords if kw in title]
    if matched_kw:
        reasons.append(f'关键词: {", ".join(matched_kw[:3])}')

    return ' | '.join(reasons) if reasons else '相关性匹配'


def _is_duplicate(r, user_id: str, tier: str, title: str) -> bool:
    """Check if a similar alert was recently sent across ALL tiers.

    Uses true Jaccard similarity on bigram sets stored in Redis.
    - Bigram sets are stored as JSON arrays so we can compute real
      intersection/union across existing dedup entries.
    - Checks all three tiers (FLASH/PRIORITY/ROUTINE), not just the
      incoming tier, to prevent near-duplicate alerts at different
      severity levels.
    - Short titles (< 4 Chinese characters or < 8 total characters)
      fall back to exact-match dedup since bigram similarity is
      unreliable on very short strings.
    """
    incoming_bigrams = _title_bigrams(title)

    # Short title: fall back to exact match across all tiers
    if incoming_bigrams is None:
        exact_hash = hashlib.md5(title.encode()).hexdigest()[:12]
        for t in TIERS:
            key = f'cn:alerts:dedup:{user_id}:{t}:exact:{exact_hash}'
            if r.exists(key) == 1:
                return True
        return False

    # Normal title: scan every dedup entry across all tiers
    for t in TIERS:
        pattern = f'cn:alerts:dedup:{user_id}:{t}:bg:*'
        cursor = 0
        while True:
            cursor, keys = r.scan(cursor, match=pattern, count=100)
            for key in keys:
                raw = r.get(key)
                if not raw:
                    continue
                try:
                    stored_bigrams = set(json.loads(raw))
                except (json.JSONDecodeError, TypeError):
                    continue
                similarity = _jaccard(incoming_bigrams, stored_bigrams)
                if similarity > 0.6:
                    return True
            if cursor == 0:
                break

    return False


def _store_dedup(r, user_id: str, tier: str, title: str, cooldown: int):
    """Store dedup data in Redis for future similarity checks.

    Short titles store an exact-match flag; normal titles store the
    full bigram set as a JSON array so _is_duplicate() can compute
    Jaccard similarity.
    """
    bigrams = _title_bigrams(title)

    if bigrams is None:
        # Short title: exact-match key
        exact_hash = hashlib.md5(title.encode()).hexdigest()[:12]
        key = f'cn:alerts:dedup:{user_id}:{tier}:exact:{exact_hash}'
        r.setex(key, cooldown, '1')
    else:
        # Normal title: store bigram set keyed by content hash
        bigram_list = sorted(bigrams)
        content_hash = hashlib.md5(','.join(bigram_list).encode()).hexdigest()[:12]
        key = f'cn:alerts:dedup:{user_id}:{tier}:bg:{content_hash}'
        r.setex(key, cooldown, json.dumps(bigram_list, ensure_ascii=False))


def _title_bigrams(title: str):
    """Extract bigram set from title for Jaccard similarity.

    Returns a set of bigrams, or None if the title is too short for
    meaningful bigram comparison (< 4 Chinese characters or < 8 total
    characters), signalling the caller to use exact-match instead.
    """
    chars = ''.join(c for c in title if '\u4e00' <= c <= '\u9fff')
    if len(chars) < 4 or len(title) < 8:
        return None
    bigrams = set()
    for i in range(len(chars) - 1):
        bigrams.add(chars[i:i + 2])
    return bigrams


def _jaccard(set_a: set, set_b: set) -> float:
    """Compute Jaccard similarity: |intersection| / |union|."""
    if not set_a and not set_b:
        return 1.0
    union = set_a | set_b
    if not union:
        return 0.0
    return len(set_a & set_b) / len(union)
