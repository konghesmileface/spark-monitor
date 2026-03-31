"""Global signals integration — fetch Telegram OSINT feeds from relay service
and score relevance against enterprise profiles.

Connects to the relay service (default localhost:3004) which aggregates
34 Telegram OSINT channels covering geopolitics, sanctions, supply chain,
energy, military, tech, and macro-economic signals.
"""

import logging
import time
import threading
import requests

from config import Config
from services.cache import cache_get, cache_set

logger = logging.getLogger('cn-intel.global-signals')

# ── Industry → global keyword mapping ────────────────────────────────────────

INDUSTRY_GLOBAL_KEYWORDS = {
    '新能源': ['energy', 'solar', 'battery', 'ev', 'lithium', 'oil', 'opec', 'renewable', 'wind power', 'hydrogen'],
    '半导体': ['semiconductor', 'chip', 'nvidia', 'tsmc', 'export control', 'asml', 'wafer', 'foundry', 'intel'],
    'AI': ['ai', 'openai', 'google', 'nvidia', 'gpu', 'llm', 'deepseek', 'artificial intelligence', 'machine learning'],
    '金融': ['bank', 'fed', 'ecb', 'interest rate', 'bond', 'inflation', 'treasury', 'forex', 'imf', 'debt'],
    '军工': ['military', 'defense', 'weapon', 'missile', 'drone', 'nato', 'arms', 'warfare', 'pentagon'],
    '医药': ['pharma', 'drug', 'fda', 'biotech', 'vaccine', 'clinical trial', 'healthcare', 'who'],
    '消费': ['consumer', 'retail', 'luxury', 'brand', 'ecommerce', 'spending'],
    '房地产': ['real estate', 'property', 'housing', 'mortgage', 'construction'],
    '通信': ['telecom', '5g', '6g', 'huawei', 'ericsson', 'spectrum', 'satellite'],
    '基建': ['infrastructure', 'railway', 'highway', 'bridge', 'construction', 'belt and road'],
    '机器人': ['robot', 'automation', 'humanoid', 'cobot', 'industrial automation'],
}

CHINA_RELEVANCE_KEYWORDS = [
    'china', 'chinese', 'beijing', 'taiwan', 'tariff', 'sanction', 'trade war',
    'us-china', 'brics', 'rare earth', 'supply chain', 'decoupling', 'export control',
    'xi jinping', 'prc', 'hong kong', 'south china sea', 'aukus', 'quad',
]

SUPPLY_CHAIN_KEYWORDS = [
    'supply chain', 'logistics', 'shipping', 'freight', 'port', 'shortage',
    'inventory', 'raw material', 'commodity', 'import', 'export', 'disruption',
]

REGION_KEYWORDS = {
    '东南亚': ['asean', 'southeast asia', 'vietnam', 'indonesia', 'thailand', 'malaysia', 'philippines', 'singapore'],
    '欧洲': ['eu', 'europe', 'germany', 'france', 'ecb', 'uk', 'britain', 'brussels'],
    '北美': ['us', 'usa', 'fed', 'american', 'canada', 'nafta', 'usmca', 'washington'],
    '中东': ['middle east', 'saudi', 'iran', 'israel', 'opec', 'gulf', 'uae', 'qatar'],
    '日韩': ['japan', 'korea', 'tokyo', 'seoul', 'boj', 'samsung', 'nikkei'],
    '南亚': ['india', 'modi', 'mumbai', 'bangladesh', 'pakistan'],
    '非洲': ['africa', 'nigeria', 'south africa', 'kenya', 'ethiopia'],
    '拉美': ['latin america', 'brazil', 'mexico', 'argentina', 'chile'],
}

# ── Global feed cache ────────────────────────────────────────────────────────

_feed_cache = {'data': None, 'ts': 0}
_feed_lock = threading.Lock()
_FEED_CACHE_TTL = 60  # seconds


def fetch_global_feed(limit: int = 100) -> list:
    """Fetch Telegram feed from relay service. Cached for 60s globally."""
    now = time.time()
    with _feed_lock:
        if _feed_cache['data'] is not None and (now - _feed_cache['ts']) < _FEED_CACHE_TTL:
            return _feed_cache['data']

    relay_url = getattr(Config, 'RELAY_URL', 'http://localhost:3004')
    try:
        resp = requests.get(
            f'{relay_url}/telegram',
            params={'limit': limit},
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            items = data if isinstance(data, list) else data.get('items', data.get('messages', []))
            with _feed_lock:
                _feed_cache['data'] = items
                _feed_cache['ts'] = time.time()
            return items
        logger.warning(f'Relay returned {resp.status_code}')
    except Exception as e:
        logger.warning(f'Relay fetch failed: {e}')

    # Return stale cache if available
    with _feed_lock:
        return _feed_cache['data'] or []


def score_item_relevance(item: dict, profile: dict) -> float:
    """Score a global signal item's relevance to a user profile (0~1).

    Multi-factor scoring:
      - Industry keywords: 0.4
      - China relevance: 0.3
      - Supply chain: 0.15
      - Region match: 0.15
    """
    text = (item.get('text', '') or item.get('content', '') or item.get('title', '')).lower()
    if not text:
        return 0.0

    score = 0.0

    # Factor 1: Industry keyword match (weight 0.4)
    industries = profile.get('industries', [])
    industry_score = 0.0
    for ind in industries:
        keywords = INDUSTRY_GLOBAL_KEYWORDS.get(ind, [])
        if keywords:
            matches = sum(1 for kw in keywords if kw in text)
            if matches:
                industry_score = max(industry_score, min(matches / 3.0, 1.0))
    # Also check tracked_keywords from profile
    tracked_kw = profile.get('tracked_keywords', [])
    if tracked_kw:
        kw_matches = sum(1 for kw in tracked_kw if kw.lower() in text)
        if kw_matches:
            industry_score = max(industry_score, min(kw_matches / 2.0, 1.0))
    score += industry_score * 0.4

    # Factor 2: China relevance (weight 0.3)
    china_matches = sum(1 for kw in CHINA_RELEVANCE_KEYWORDS if kw in text)
    if china_matches:
        score += min(china_matches / 3.0, 1.0) * 0.3

    # Factor 3: Supply chain (weight 0.15)
    supply_up = [s.lower() for s in profile.get('supply_chain_up', [])]
    supply_down = [s.lower() for s in profile.get('supply_chain_down', [])]
    supply_score = 0.0
    # Check general supply chain keywords
    sc_matches = sum(1 for kw in SUPPLY_CHAIN_KEYWORDS if kw in text)
    if sc_matches:
        supply_score = min(sc_matches / 3.0, 1.0) * 0.5
    # Check specific supply chain entities
    for entity in supply_up + supply_down:
        if entity and entity in text:
            supply_score = max(supply_score, 0.8)
            break
    # Check competitors
    competitors = [c.lower() for c in profile.get('competitors', [])]
    for comp in competitors:
        if comp and comp in text:
            supply_score = max(supply_score, 0.6)
            break
    score += supply_score * 0.15

    # Factor 4: Region match (weight 0.15)
    user_regions = profile.get('business_regions', [])
    region_score = 0.0
    for region_name, keywords in REGION_KEYWORDS.items():
        region_matches = sum(1 for kw in keywords if kw in text)
        if region_matches:
            # Bonus if user has matching business region
            if any(region_name in r or r in region_name for r in user_regions):
                region_score = max(region_score, min(region_matches / 2.0, 1.0))
            else:
                region_score = max(region_score, min(region_matches / 4.0, 0.5))
    score += region_score * 0.15

    return round(min(score, 1.0), 3)


def fetch_relevant_global_signals(user_id: str, top_n: int = 8) -> list:
    """Fetch global feed, score against user profile, return top relevant items.
    Per-user cache for 5 minutes."""
    cache_key = f'cn:global-signals:{user_id}'
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    # Load profile
    from services.user_profile import get_profile
    profile = get_profile(user_id)
    if not profile or not profile.get('industries'):
        return []

    # Fetch and score
    feed = fetch_global_feed(limit=100)
    if not feed:
        return []

    scored = []
    for item in feed:
        rel = score_item_relevance(item, profile)
        if rel >= 0.2:
            scored.append({
                'text': (item.get('text', '') or item.get('content', '') or '')[:300],
                'channel': item.get('channel', '') or item.get('source', ''),
                'date': item.get('date', '') or item.get('timestamp', ''),
                'relevance': rel,
            })

    scored.sort(key=lambda x: x['relevance'], reverse=True)
    result = scored[:top_n]

    cache_set(cache_key, result, 300)  # 5 min
    return result


def build_global_signal_context(user_id: str, max_items: int = 5) -> str:
    """Build a text block ready to inject into AI prompts.
    Returns empty string if no relevant signals found."""
    signals = fetch_relevant_global_signals(user_id, top_n=max_items)
    if not signals:
        return ''

    lines = []
    for s in signals[:max_items]:
        channel = s.get('channel', '?')
        text = s.get('text', '')[:200]
        rel = s.get('relevance', 0)
        lines.append(f'- [{channel}] (相关度:{rel:.0%}) {text}')

    return f'全球OSINT信号({len(lines)}条):\n' + '\n'.join(lines)
