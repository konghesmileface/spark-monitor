"""Relevance scoring engine — ranks policy/sentiment items against user profiles.

4-dimensional relevance scoring (0-1):
  - Industry keywords:   0.4 weight
  - Sector entities:     0.3 weight
  - Stock mentions:      0.2 weight
  - Custom keywords:     0.1 weight
"""

import logging
from services.cn_entity_registry import find_entities_in_text, TYPE_SECTOR, TYPE_STOCK

logger = logging.getLogger('cn-intel.relevance')


def score_relevance(item: dict, profile: dict) -> float:
    """Score a single item (policy/mood) against a user profile.
    Returns 0.0-1.0 relevance score."""
    if not profile:
        return 0.0

    title = item.get('title', '')
    category = item.get('category', '')
    text = f"{title} {category}"

    industries = profile.get('industries', [])
    tracked_sectors = profile.get('tracked_sectors', [])
    tracked_stocks = profile.get('tracked_stocks', [])
    tracked_keywords = profile.get('tracked_keywords', [])

    # Expand industries into sector keywords
    from services.user_profile import INDUSTRY_TO_SECTORS
    expanded_sectors = set(tracked_sectors)
    industry_keywords = set()
    for ind in industries:
        industry_keywords.add(ind)
        for s in INDUSTRY_TO_SECTORS.get(ind, []):
            expanded_sectors.add(s)
            industry_keywords.add(s)

    score = 0.0
    matched_keywords = []

    # Dimension 1: Industry keyword match (weight 0.4)
    # Cap denominator at 3 so a single match is meaningful even with many industries
    if industry_keywords:
        hits = [kw for kw in industry_keywords if kw in text]
        if hits:
            score += 0.4 * min(len(hits) / min(len(industry_keywords), 3), 1.0)
            matched_keywords.extend(hits)

    # Dimension 2: Sector entity match (weight 0.3)
    if expanded_sectors:
        entities = find_entities_in_text(text, max_results=20)
        sector_entities = [e for e in entities if e.get('type') == TYPE_SECTOR]
        sector_names = {e.get('name', '') for e in sector_entities}
        sector_hits = sector_names & expanded_sectors
        if sector_hits:
            score += 0.3 * min(len(sector_hits) / max(len(expanded_sectors), 1), 1.0)
            matched_keywords.extend(sector_hits)

    # Dimension 3: Stock mention (weight 0.2)
    if tracked_stocks:
        stock_entities = find_entities_in_text(text, max_results=30)
        stock_codes = {e.get('code', '') for e in stock_entities if e.get('type') == TYPE_STOCK}
        stock_hits = []
        for code in tracked_stocks:
            # Match partial codes (e.g., "600519" matches "600519")
            for ecode in stock_codes:
                if code in ecode or ecode.startswith(code):
                    stock_hits.append(code)
                    break
            # Also check if stock code appears directly in text
            if code in text:
                stock_hits.append(code)
        stock_hits = list(set(stock_hits))
        if stock_hits:
            score += 0.2 * min(len(stock_hits) / max(len(tracked_stocks), 1), 1.0)
            matched_keywords.extend(stock_hits)

    # Dimension 4: Custom keywords (weight 0.1)
    # Cap denominator at 3 so a single match is meaningful even with many keywords
    if tracked_keywords:
        kw_hits = [kw for kw in tracked_keywords if kw in text]
        if kw_hits:
            score += 0.1 * min(len(kw_hits) / min(len(tracked_keywords), 3), 1.0)
            matched_keywords.extend(kw_hits)

    return min(score, 1.0)


def filter_items_for_user(items: list, profile: dict, min_relevance: float = 0.3) -> list:
    """Filter and sort items by relevance to user profile.
    Returns items with _relevance_score >= min_relevance, sorted descending."""
    if not profile:
        return items

    scored = enrich_items_with_relevance(items, profile)
    filtered = [it for it in scored if it.get('_relevance_score', 0) >= min_relevance]
    filtered.sort(key=lambda x: x.get('_relevance_score', 0), reverse=True)
    return filtered


def enrich_items_with_relevance(items: list, profile: dict) -> list:
    """Add _relevance_score and _matched_keywords to each item."""
    if not profile:
        return items

    industries = profile.get('industries', [])
    tracked_sectors = profile.get('tracked_sectors', [])
    tracked_stocks = profile.get('tracked_stocks', [])
    tracked_keywords = profile.get('tracked_keywords', [])

    from services.user_profile import INDUSTRY_TO_SECTORS
    expanded_sectors = set(tracked_sectors)
    industry_keywords = set()
    for ind in industries:
        industry_keywords.add(ind)
        for s in INDUSTRY_TO_SECTORS.get(ind, []):
            expanded_sectors.add(s)
            industry_keywords.add(s)

    all_keywords = industry_keywords | expanded_sectors | set(tracked_stocks) | set(tracked_keywords)

    result = []
    for item in items:
        text = f"{item.get('title', '')} {item.get('category', '')}"
        matched = [kw for kw in all_keywords if kw in text]
        rel_score = score_relevance(item, profile)
        enriched = dict(item)
        enriched['_relevance_score'] = round(rel_score, 3)
        enriched['_matched_keywords'] = list(set(matched))
        result.append(enriched)
    return result
