#!/usr/bin/env python3
"""Daily automation pipeline for cn-intel-service.
Run via cron: 0 5 * * * cd /path/to/cn-intel-service && python scripts/daily_pipeline.py
"""
import sys
import os
import logging
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.WARNING, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('daily-pipeline')

def run_pipeline():
    logger.warning(f'Starting daily pipeline at {datetime.now().isoformat()}')

    # Step 1: Fetch market data
    logger.warning('Step 1: Fetching market data...')
    from services.akshare_data import get_market_overview, get_sentiment_data, get_research_reports
    market_data = get_market_overview()
    logger.warning(f'  Market data: {len(market_data.get("indices", []))} indices, {len(market_data.get("sectors", []))} sectors')

    sentiment_data = get_sentiment_data()
    logger.warning(f'  Sentiment: {sentiment_data.get("label", "N/A")} ({sentiment_data.get("score", 0)})')

    research_data = get_research_reports()
    logger.warning(f'  Research: {len(research_data.get("reports", []))} reports')

    # Step 2: Fetch social mood
    logger.warning('Step 2: Fetching social mood...')
    from services.media_crawler import get_social_mood
    mood_data = get_social_mood()
    total_posts = len(mood_data.get('weibo', [])) + len(mood_data.get('zhihu', [])) + len(mood_data.get('xiaohongshu', []))
    logger.warning(f'  Social mood: {total_posts} posts collected')

    # Step 3: Detect hot events
    logger.warning('Step 3: Detecting hot events...')
    from services.hot_events import get_hot_events
    events_data = get_hot_events()
    logger.warning(f'  Hot events: {len(events_data.get("events", []))} events')

    # Step 4: Generate daily brief
    logger.warning('Step 4: Generating daily brief...')
    from services.ai_analysis import generate_daily_brief
    brief = generate_daily_brief(market_data, sentiment_data, research_data, mood_data)
    logger.warning(f'  Brief generated: {len(brief.get("content", ""))} chars')

    # Step 5: Cache all results
    logger.warning('Step 5: Caching results...')
    try:
        import redis
        from config import Config
        r = redis.Redis(host=Config.REDIS_HOST, port=Config.REDIS_PORT, db=Config.REDIS_DB, decode_responses=True)
        import json
        r.setex('cn:market:overview', Config.CACHE_TTL_MARKET, json.dumps(market_data, ensure_ascii=False, default=str))
        r.setex('cn:sentiment:index', Config.CACHE_TTL_SENTIMENT, json.dumps(sentiment_data, ensure_ascii=False, default=str))
        r.setex('cn:research:reports', Config.CACHE_TTL_RESEARCH, json.dumps(research_data, ensure_ascii=False, default=str))
        r.setex('cn:mood:social', Config.CACHE_TTL_MOOD, json.dumps(mood_data, ensure_ascii=False, default=str))
        r.setex('cn:hot-events:latest', Config.CACHE_TTL_HOT_EVENTS_OFF, json.dumps(events_data, ensure_ascii=False, default=str))
        r.setex('cn:brief:latest', Config.CACHE_TTL_BRIEF, json.dumps(brief, ensure_ascii=False, default=str))
        logger.warning('  All data cached to Redis')
    except Exception as e:
        logger.warning(f'  Redis caching failed: {e}')

    logger.warning(f'Daily pipeline completed at {datetime.now().isoformat()}')

if __name__ == '__main__':
    run_pipeline()
