import logging
import threading
from datetime import datetime
from services.cache import cache_get, cache_set, _memory_cache
from services.ai_analysis import generate_daily_brief
from services.akshare_data import get_market_overview, get_sentiment_data, get_research_reports

logger = logging.getLogger('cn-intel.brief')

# Guard: only one background regeneration at a time
_bg_regenerating = False


def _generate_fresh(cache_key):
    """Gather data from all dimensions and generate brief via AI."""
    # ── Dimension 1: Market Data ──
    market_data = get_market_overview()
    sentiment_data = get_sentiment_data()
    research_data = get_research_reports()

    # ── Dimension 2: Hot Events ──
    hot_events_data = None
    try:
        from services.hot_events import get_hot_events
        hot_events_data = get_hot_events()
    except Exception as e:
        logger.warning(f'Hot events fetch failed: {e}')

    # ── Dimension 3: Policy/Gov News ──
    policy_data = None
    try:
        policy_cache = cache_get('cn:gov-news')
        if policy_cache:
            policy_data = policy_cache
        else:
            from services.gov_news_crawler import get_gov_news
            policy_data = get_gov_news()
    except Exception as e:
        logger.warning(f'Policy news fetch failed: {e}')

    brief = generate_daily_brief(market_data, sentiment_data, research_data,
                                 hot_events_data=hot_events_data,
                                 policy_data=policy_data)

    if brief:
        brief = _annotate_entities_in_brief(brief)
        cache_set(cache_key, brief, 21600)  # 6 hours

    return brief


def get_or_generate_brief(force=False):
    """Get cached brief or generate a new one.
    Uses stale-while-revalidate: if cache expired but stale data exists,
    return stale immediately and regenerate in background."""
    global _bg_regenerating
    cache_key = 'cn:brief:latest'

    # Grab stale reference BEFORE cache_get (which evicts expired entries)
    stale = _memory_cache.get(cache_key)

    if not force:
        cached = cache_get(cache_key)
        if cached:
            return cached

    # Cache miss — return stale immediately if available, regenerate in background
    if stale and not force:
        if not _bg_regenerating:
            _bg_regenerating = True
            from flask import current_app
            app = current_app._get_current_object()

            def _regen():
                global _bg_regenerating
                try:
                    with app.app_context():
                        _generate_fresh(cache_key)
                        logger.warning('Background brief regeneration completed')
                except Exception as e:
                    logger.warning(f'Background brief regeneration failed: {e}')
                finally:
                    _bg_regenerating = False

            threading.Thread(target=_regen, daemon=True).start()
            logger.warning('Returning stale brief, regenerating in background')
        # Return stale data (whether we just started bg regen or it was already running)
        result = stale.copy() if isinstance(stale, dict) else stale
        if isinstance(result, dict):
            result['_stale'] = True
        return result

    # No stale data — synchronous generation (first-ever or force refresh)
    return _generate_fresh(cache_key)


def _annotate_entities_in_brief(brief):
    """Post-process brief sections to add entity annotations.
    Adds 'entities' field to each section with found entities and their positions."""
    try:
        from services.cn_entity_registry import find_entities_in_text
    except ImportError:
        return brief

    sections = brief.get('sections', [])
    all_entities = []

    for section in sections:
        content = section.get('content', '')
        if not content:
            continue
        entities = find_entities_in_text(content, max_results=5)
        if entities:
            section['entities'] = [
                {'id': e['id'], 'name': e['name'], 'type': e['type'],
                 'code': e.get('code', ''), 'sector': e.get('sector', '')}
                for e in entities
            ]
            all_entities.extend(entities)

    # Add deduplicated entity summary at brief level
    seen = set()
    unique = []
    for e in all_entities:
        if e['id'] not in seen:
            seen.add(e['id'])
            unique.append({
                'id': e['id'], 'name': e['name'], 'type': e['type'],
                'code': e.get('code', ''), 'sector': e.get('sector', ''),
            })
    brief['mentionedEntities'] = unique[:20]

    return brief
