"""Co-occurrence network: build entity co-occurrence relationships from social media posts + news.
Nodes = entities (stocks, sectors, policy bodies), Edges = co-mention weight.
Cached for 10 minutes to avoid repeated computation."""

import logging
from collections import defaultdict
from services.cache import cache_get, cache_set
from services.cn_entity_registry import find_entities_in_text

logger = logging.getLogger('cn-intel.cooccurrence')

_CACHE_KEY = 'cn:cooccurrence:network'
_CACHE_TTL = 600  # 10 minutes


def build_co_occurrence_network(min_weight=2, max_nodes=30):
    """Build co-occurrence network from social media posts + DB news.

    Returns:
        {
            nodes: [{id, name, type, sector, mentions}],
            edges: [{source, target, weight}],
            timestamp
        }
    """
    from datetime import datetime

    # Check cache
    cached = cache_get(_CACHE_KEY)
    if cached:
        return cached

    # Collect texts from social media (cached mood data)
    texts = []
    mood_data = cache_get('cn:mood:social')
    if mood_data:
        platforms = mood_data.get('platforms', {})
        for posts in platforms.values():
            for post in posts:
                content = post.get('content', '')
                if content:
                    texts.append(content)

    # Collect from hot events (cached)
    events_data = cache_get('cn:hot-events:latest')
    if events_data:
        for event in events_data.get('events', []):
            title = event.get('title', '')
            summary = event.get('summary', '')
            if title:
                texts.append(title + ' ' + summary)

    # Collect from recent news in DB
    try:
        import pymysql
        from datetime import timedelta
        from services.db_pool import get_connection
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cutoff = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')
                cur.execute(
                    """SELECT info_title, resume FROM news
                       WHERE type='0' AND news_date >= %s
                       ORDER BY news_date DESC LIMIT 50""",
                    [cutoff],
                )
                for row in cur.fetchall():
                    title = str(row.get('info_title') or '')
                    resume = str(row.get('resume') or '')
                    if title:
                        texts.append(title + ' ' + resume)
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'Co-occurrence DB news fetch failed: {e}')

    if not texts:
        empty = {'nodes': [], 'edges': [], 'timestamp': datetime.now().isoformat()}
        cache_set(_CACHE_KEY, empty, _CACHE_TTL)
        return empty

    # Count entity mentions and co-occurrences
    entity_mentions = defaultdict(int)  # entity_id → total mentions
    co_occur = defaultdict(int)  # (id_a, id_b) sorted → weight

    for text in texts:
        entities = find_entities_in_text(text, max_results=10)
        if not entities:
            continue
        for e in entities:
            entity_mentions[e['id']] += 1
        # Record pairwise co-occurrences
        ids = [e['id'] for e in entities]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pair = tuple(sorted([ids[i], ids[j]]))
                co_occur[pair] += 1

    # Build nodes (top N by mentions)
    all_entities = sorted(entity_mentions.items(), key=lambda x: x[1], reverse=True)[:max_nodes]
    node_ids = {eid for eid, _ in all_entities}

    from services.cn_entity_registry import _by_id
    nodes = []
    for eid, mentions in all_entities:
        entity = _by_id.get(eid, {})
        nodes.append({
            'id': eid,
            'name': entity.get('name', eid),
            'type': entity.get('type', ''),
            'sector': entity.get('sector', ''),
            'mentions': mentions,
        })

    # Build edges (filter by min_weight and node inclusion)
    edges = []
    for (id_a, id_b), weight in co_occur.items():
        if weight >= min_weight and id_a in node_ids and id_b in node_ids:
            edges.append({
                'source': id_a,
                'target': id_b,
                'weight': weight,
            })

    # Sort edges by weight descending
    edges.sort(key=lambda x: x['weight'], reverse=True)

    result = {
        'nodes': nodes,
        'edges': edges[:100],  # Cap at 100 edges
        'total_texts': len(texts),
        'timestamp': datetime.now().isoformat(),
    }
    cache_set(_CACHE_KEY, result, _CACHE_TTL)
    return result
