"""Tool registry for AI agent tool-calling (WorldMonitor pattern).
Wraps existing cn-intel-service data functions as OpenAI-compatible tools."""

import json
import logging
import traceback

logger = logging.getLogger('cn-intel.tools')

_tools = {}


def register(name, fn, schema, category='general'):
    """Register a tool with OpenAI function-calling schema."""
    _tools[name] = {
        'name': name,
        'fn': fn,
        'schema': schema,
        'category': category,
    }


def execute(name, args=None):
    """Execute tool by name, return result dict."""
    if name not in _tools:
        return {'error': f'Unknown tool: {name}'}
    tool = _tools[name]
    try:
        result = tool['fn'](args or {})
        logger.warning(f'Tool {name} executed OK')
        return result
    except Exception as e:
        logger.warning(f'Tool {name} failed: {e}\n{traceback.format_exc()}')
        return {'error': str(e)}


def get_tool_schemas(category=None):
    """Return OpenAI-compatible function schemas for LLM tool-calling."""
    schemas = []
    for tool in _tools.values():
        if category and tool['category'] != category:
            continue
        schemas.append({
            'type': 'function',
            'function': tool['schema'],
        })
    return schemas


def get_tool_names():
    """Return list of registered tool names."""
    return list(_tools.keys())


# --- Tool implementations (wrap existing functions) ---

def _wm_market_overview(args):
    """Get A-share market overview: indices, sectors, northbound, limit stats."""
    from services.akshare_data import get_market_overview
    from services.cache import cache_get, cache_set
    cached = cache_get('cn:market:overview')
    if cached:
        return cached
    data = get_market_overview()
    cache_set('cn:market:overview', data, 120)
    return data


def _wm_sentiment(args):
    """Get market sentiment score and factors."""
    from services.akshare_data import get_sentiment_data
    from services.cache import cache_get, cache_set
    cached = cache_get('cn:sentiment:data')
    if cached:
        return cached
    data = get_sentiment_data()
    cache_set('cn:sentiment:data', data, 300)
    return data


def _wm_search_reports(args):
    """Search research reports by keyword."""
    from services.akshare_data import get_db_research_reports
    keyword = args.get('keyword', '')
    data = get_db_research_reports(page=1, page_size=5, keyword=keyword)
    # Return summarized version (no full content) to keep token count low
    reports = []
    for r in data.get('reports', []):
        reports.append({
            'title': r.get('title', ''),
            'institution': r.get('institution', ''),
            'date': r.get('date', ''),
            'summary': (r.get('summary') or '')[:200],
            'emotion': r.get('emotion'),
        })
    return {'reports': reports, 'total': data.get('total', 0)}


def _wm_hot_events(args):
    """Get today's hot market events (concept boards)."""
    from services.hot_events import get_hot_events
    from services.cache import cache_get, cache_set
    cached = cache_get('cn:hot-events:latest')
    if cached:
        return cached
    data = get_hot_events()
    from services.cache import is_trading_time
    from config import Config
    ttl = Config.CACHE_TTL_HOT_EVENTS_TRADING if is_trading_time() else Config.CACHE_TTL_HOT_EVENTS_OFF
    cache_set('cn:hot-events:latest', data, ttl)
    return data


def _wm_funding_rates(args):
    """Get interbank funding rates (SHIBOR etc)."""
    import requests
    try:
        resp = requests.get(
            'http://datacenter-web.eastmoney.com/api/data/v1/get',
            params={
                'reportName': 'RPT_IMP_INT',
                'columns': 'ALL',
                'pageSize': '5',
                'pageNumber': '1',
                'sortColumns': 'IR_RATE_DATE',
                'sortTypes': '-1',
                'source': 'WEB',
                'client': 'WEB',
                'filter': '(IR_RATE_NAME="SHIBOR")',
            },
            headers={
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'http://data.eastmoney.com/',
            },
            timeout=10,
            proxies={'http': None, 'https': None},
        )
        data = resp.json()
        items = data.get('result', {}).get('data', [])
        rates = []
        for item in items[:5]:
            rates.append({
                'date': str(item.get('IR_RATE_DATE', ''))[:10],
                'overnight': item.get('IR_RATE_O_N'),
                '1w': item.get('IR_RATE_1W'),
                '2w': item.get('IR_RATE_2W'),
                '1m': item.get('IR_RATE_1M'),
                '3m': item.get('IR_RATE_3M'),
            })
        return {'rates': rates, 'source': 'SHIBOR'}
    except Exception as e:
        return {'error': str(e), 'rates': []}


def _wm_policy_search(args):
    """Search policy store by keyword."""
    from services import policy_store
    keyword = args.get('keyword', '')
    if not keyword:
        return {'items': [], 'total': 0}
    items = policy_store.search_items(keyword, limit=8)
    return {'items': items[:8], 'total': len(items)}


def _wm_stock_detail(args):
    """Get individual stock quote detail — via data_provider (any stock, not just top movers)."""
    code = args.get('code', '')
    name = args.get('name', '')
    if not code and not name:
        return {'error': 'Need code or name parameter'}

    # Try entity dict lookup first
    try:
        from services.hot_events import _STOCK_ALIASES, _ALIAS_TO_STOCK
        if name and name in _ALIAS_TO_STOCK:
            real_name, code = _ALIAS_TO_STOCK[name]
    except ImportError:
        pass

    # If we have name but no code, search in spot data
    if name and not code:
        from services.data_provider import get_a_spot
        spots = get_a_spot()
        for s in spots:
            if name in s.get('name', ''):
                code = s.get('code', '')
                break

    if not code:
        return {'code': '', 'name': name, 'error': '未找到匹配的股票代码'}

    # Get real-time quote + basic info via data_provider
    from services.data_provider import get_stock_quote, get_stock_info
    quote = get_stock_quote(code)
    info = get_stock_info(code)

    result = {'code': code}
    if quote:
        result.update(quote)
    if info:
        # Merge info fields that quote doesn't have
        for k in ('pe', 'pb', 'totalMv', 'circulatingMv', 'industry', 'listingDate'):
            if info.get(k) and not result.get(k):
                result[k] = info[k]
    if not result.get('name') and name:
        result['name'] = name
    return result


def _wm_stock_history(args):
    """Get historical K-line data for a stock."""
    code = args.get('code', '')
    days = int(args.get('days', 30))

    # Try name lookup if no code
    name = args.get('name', '')
    if name and not code:
        try:
            from services.hot_events import _ALIAS_TO_STOCK
            if name in _ALIAS_TO_STOCK:
                _, code = _ALIAS_TO_STOCK[name]
        except ImportError:
            pass
    if name and not code:
        from services.data_provider import get_a_spot
        for s in get_a_spot():
            if name in s.get('name', ''):
                code = s.get('code', '')
                break

    if not code:
        return {'error': 'Need code or name parameter'}

    from services.data_provider import get_stock_hist
    records = get_stock_hist(code, period='daily', days=min(days, 120))
    if not records:
        return {'code': code, 'klines': [], 'note': '暂无历史数据'}

    return {
        'code': code,
        'days': len(records),
        'klines': records,
    }


def _wm_fund_flow(args):
    """Get individual stock fund flow (主力/散户 资金流向)."""
    code = args.get('code', '')
    name = args.get('name', '')
    if name and not code:
        try:
            from services.hot_events import _ALIAS_TO_STOCK
            if name in _ALIAS_TO_STOCK:
                _, code = _ALIAS_TO_STOCK[name]
        except ImportError:
            pass
    if name and not code:
        from services.data_provider import get_a_spot
        for s in get_a_spot():
            if name in s.get('name', ''):
                code = s.get('code', '')
                break

    if not code:
        return {'error': 'Need code or name parameter'}

    from services.data_provider import get_fund_flow
    result = get_fund_flow(code)
    if not result:
        return {'code': code, 'note': '暂无资金流向数据'}
    return result


def _wm_mood_keywords(args):
    """Get current social media mood keywords and sentiment distribution."""
    from services.cache import cache_get
    cached = cache_get('cn:mood:social')
    if not cached:
        return {'keywords': [], 'distribution': {}}
    return {
        'keywords': cached.get('keywords', [])[:15],
        'distribution': cached.get('distribution', {}),
        'platformBreakdown': {k: v for k, v in list(cached.get('platformBreakdown', {}).items())[:5]},
    }


def _wm_policy_chain(args):
    """Build policy impact chain."""
    title = args.get('title', '')
    content = args.get('content', '')
    if not title:
        return {'error': 'Need title parameter'}
    from services.policy_chains import build_impact_chain
    result = build_impact_chain(title, content)
    # Return compact version for tool response
    return {
        'causalChain': result.get('causalChain', []),
        'impactedSectors': result.get('impactedSectors', []),
        'relatedPolicies': [p['title'] for p in result.get('relatedPolicies', [])[:5]],
    }


def _wm_co_occurrence(args):
    """Get entity co-occurrence network."""
    from services.co_occurrence import build_co_occurrence_network
    result = build_co_occurrence_network(min_weight=2, max_nodes=20)
    # Return compact version
    return {
        'nodes': [{'name': n['name'], 'mentions': n['mentions']} for n in result.get('nodes', [])[:15]],
        'edges': [{'source': e['source'], 'target': e['target'], 'weight': e['weight']}
                  for e in result.get('edges', [])[:20]],
    }


def _wm_entity_sentiment(args):
    """Get entity-level sentiment from social media."""
    entity_name = args.get('entity', '')
    from services.media_crawler import get_entity_sentiment
    from services.cache import cache_get, cache_set
    cache_key = f'cn:mood:entity-sentiment:{entity_name or "all"}'
    cached = cache_get(cache_key)
    if cached:
        return cached
    data = get_entity_sentiment(entity_name=entity_name or None, top_n=10)
    cache_set(cache_key, data, 300)
    return data


def _wm_recent_news(args):
    """Search recent DB news by keyword."""
    import pymysql
    from services.db_pool import get_connection
    keyword = args.get('keyword', '')
    if not keyword:
        return {'news': [], 'total': 0}
    try:
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    """SELECT info_title, news_date, media, resume, emotion
                       FROM news WHERE type='0' AND info_title LIKE %s
                       ORDER BY news_date DESC LIMIT 8""",
                    [f'%{keyword}%'],
                )
                rows = cur.fetchall()
                news = []
                for r in rows:
                    news.append({
                        'title': str(r.get('info_title') or ''),
                        'date': str(r.get('news_date') or '')[:10],
                        'source': str(r.get('media') or ''),
                        'summary': str(r.get('resume') or '')[:120],
                        'emotion': str(r.get('emotion') or '中性'),
                    })
                return {'news': news, 'total': len(news)}
        finally:
            conn.close()
    except Exception as e:
        return {'error': str(e), 'news': []}


def _wm_macro_indicators(args):
    """Get macro economic indicators (CPI/PPI/PMI)."""
    from services.data_provider import get_macro_indicators
    return get_macro_indicators()


def _wm_technical_indicators(args):
    """Get technical indicators for a stock."""
    code = args.get('code', '')
    name = args.get('name', '')
    days = int(args.get('days', 60))

    if name and not code:
        try:
            from services.hot_events import _ALIAS_TO_STOCK
            if name in _ALIAS_TO_STOCK:
                _, code = _ALIAS_TO_STOCK[name]
        except ImportError:
            pass
    if name and not code:
        from services.data_provider import get_a_spot
        for s in get_a_spot():
            if name in s.get('name', ''):
                code = s.get('code', '')
                break

    if not code:
        return {'error': 'Need code or name parameter'}

    from services.data_provider import get_technical_indicators
    result = get_technical_indicators(code, days=min(days, 120))
    # Return summary only for tool response (compact)
    if 'summary' in result:
        return {'code': code, 'summary': result['summary'], 'days': result.get('days', 0)}
    return result


def _wm_sector_rotation(args):
    """Get sector rotation momentum analysis."""
    top_n = int(args.get('top', 20))
    from services.data_provider import get_sector_rotation
    data = get_sector_rotation(top_n=min(top_n, 30))
    # Return compact version for tool
    return {
        'inflow': data.get('inflow', []),
        'outflow': data.get('outflow', []),
        'totalSectors': len(data.get('sectors', [])),
    }


def _wm_cross_signals(args):
    """Get cross-domain correlation signals (Policy+Sentiment+Market)."""
    from services.cross_domain_engine import build_correlation_context, detect_cross_signals
    sectors_str = args.get('sectors', '')
    sectors = [s.strip() for s in sectors_str.split(',') if s.strip()] if sectors_str else None
    context = build_correlation_context(sectors)
    signals = detect_cross_signals(context)
    return {'signals': signals[:10], 'total': len(signals)}


def _wm_trade_ideas(args):
    """Generate AI trade ideas from cross-domain signals."""
    from services.cross_domain_engine import generate_trade_ideas
    user_id = args.get('user_id', '')
    ideas = generate_trade_ideas(user_id=user_id or None)
    return {'ideas': ideas[:6], 'total': len(ideas)}


# --- Registration ---

def register_all_tools():
    """Register all WorldMonitor tools. Called once at startup."""
    register('wm_market_overview', _wm_market_overview, {
        'name': 'wm_market_overview',
        'description': '获取A股大盘指数(上证/深证/创业板/科创50)、涨跌统计、北向资金净流入、板块涨幅排名',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='market')

    register('wm_sentiment', _wm_sentiment, {
        'name': 'wm_sentiment',
        'description': '获取市场情绪指数(0-100分)、贪婪/恐惧标签、5个因子(涨跌比/成交量/北向/波动率/融资融券)',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='market')

    register('wm_search_reports', _wm_search_reports, {
        'name': 'wm_search_reports',
        'description': '按关键词搜索研报库，返回匹配的研报标题、机构、摘要',
        'parameters': {
            'type': 'object',
            'properties': {
                'keyword': {
                    'type': 'string',
                    'description': '搜索关键词(股票名、行业、机构等)',
                },
            },
            'required': ['keyword'],
        },
    }, category='research')

    register('wm_hot_events', _wm_hot_events, {
        'name': 'wm_hot_events',
        'description': '获取今日热点概念板块(涨幅排名、领涨股、成交额)',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='market')

    register('wm_funding_rates', _wm_funding_rates, {
        'name': 'wm_funding_rates',
        'description': '获取银行间市场资金面利率(SHIBOR隔夜/1周/2周/1月/3月)',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='market')

    register('wm_policy_search', _wm_policy_search, {
        'name': 'wm_policy_search',
        'description': '按关键词搜索政策库，返回相关政策标题、来源、日期',
        'parameters': {
            'type': 'object',
            'properties': {
                'keyword': {
                    'type': 'string',
                    'description': '搜索关键词(如"降息"、"房地产"、"碳中和")',
                },
            },
            'required': ['keyword'],
        },
    }, category='policy')

    register('wm_stock_detail', _wm_stock_detail, {
        'name': 'wm_stock_detail',
        'description': '查询个股详细行情(代码或名称)，返回实时价格、涨跌幅、PE/PB、市值、行业',
        'parameters': {
            'type': 'object',
            'properties': {
                'code': {'type': 'string', 'description': '股票代码(如600519)'},
                'name': {'type': 'string', 'description': '股票名称或别名(如茅台)'},
            },
        },
    }, category='market')

    register('wm_stock_history', _wm_stock_history, {
        'name': 'wm_stock_history',
        'description': '查询个股历史K线(日K)，返回最近N天的开/高/低/收/量/涨跌幅，可分析走势',
        'parameters': {
            'type': 'object',
            'properties': {
                'code': {'type': 'string', 'description': '股票代码(如600519)'},
                'name': {'type': 'string', 'description': '股票名称或别名(如茅台)'},
                'days': {'type': 'integer', 'description': '天数(默认30，最多120)'},
            },
        },
    }, category='market')

    register('wm_fund_flow', _wm_fund_flow, {
        'name': 'wm_fund_flow',
        'description': '查询个股资金流向(主力/超大单/大单/中单/小单净流入)，分析资金面',
        'parameters': {
            'type': 'object',
            'properties': {
                'code': {'type': 'string', 'description': '股票代码(如600519)'},
                'name': {'type': 'string', 'description': '股票名称或别名(如茅台)'},
            },
        },
    }, category='market')

    register('wm_mood_keywords', _wm_mood_keywords, {
        'name': 'wm_mood_keywords',
        'description': '获取当前社交媒体舆情热词、正面/负面/中性分布、平台情绪概况',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='sentiment')

    register('wm_entity_sentiment', _wm_entity_sentiment, {
        'name': 'wm_entity_sentiment',
        'description': '获取特定股票或全部股票的社交媒体情绪统计(正面/负面/中性提及数量)',
        'parameters': {
            'type': 'object',
            'properties': {
                'entity': {
                    'type': 'string',
                    'description': '股票名称(如"茅台"、"宁德时代")，留空返回所有被提及的实体',
                },
            },
        },
    }, category='sentiment')

    register('wm_recent_news', _wm_recent_news, {
        'name': 'wm_recent_news',
        'description': '按关键词搜索近期新闻数据库，返回标题、日期、来源、摘要',
        'parameters': {
            'type': 'object',
            'properties': {
                'keyword': {
                    'type': 'string',
                    'description': '搜索关键词',
                },
            },
            'required': ['keyword'],
        },
    }, category='news')

    register('wm_policy_chain', _wm_policy_chain, {
        'name': 'wm_policy_chain',
        'description': '分析一条政策的因果影响链(原因→效果→受影响板块→时间线)',
        'parameters': {
            'type': 'object',
            'properties': {
                'title': {'type': 'string', 'description': '政策/新闻标题'},
                'content': {'type': 'string', 'description': '可选的政策内容正文'},
            },
            'required': ['title'],
        },
    }, category='policy')

    register('wm_co_occurrence', _wm_co_occurrence, {
        'name': 'wm_co_occurrence',
        'description': '获取实体共现关系网络(哪些股票/板块/政策机构经常在同一篇文章中被同时提及)',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='knowledge')

    register('wm_macro_indicators', _wm_macro_indicators, {
        'name': 'wm_macro_indicators',
        'description': '获取宏观经济指标(CPI/PPI/PMI)最近12个月数据，分析经济趋势',
        'parameters': {
            'type': 'object',
            'properties': {},
        },
    }, category='market')

    register('wm_technical_indicators', _wm_technical_indicators, {
        'name': 'wm_technical_indicators',
        'description': '计算个股技术指标(RSI14/MACD/布林带/均线)，返回最新信号(超买超卖/多空/突破)',
        'parameters': {
            'type': 'object',
            'properties': {
                'code': {'type': 'string', 'description': '股票代码(如600519)'},
                'name': {'type': 'string', 'description': '股票名称或别名(如茅台)'},
                'days': {'type': 'integer', 'description': '天数(默认60，最多120)'},
            },
        },
    }, category='market')

    register('wm_sector_rotation', _wm_sector_rotation, {
        'name': 'wm_sector_rotation',
        'description': '板块轮动分析：对比当前涨跌幅与5日均值，识别加速/减速/强势/弱势板块',
        'parameters': {
            'type': 'object',
            'properties': {
                'top': {'type': 'integer', 'description': '分析板块数(默认20)'},
            },
        },
    }, category='market')

    register('wm_cross_signals', _wm_cross_signals, {
        'name': 'wm_cross_signals',
        'description': '获取政策+舆情+市场三域跨域关联信号，识别CONVERGENCE/DIVERGENCE/TRIPLE/LEADING模式',
        'parameters': {
            'type': 'object',
            'properties': {
                'sectors': {'type': 'string', 'description': '逗号分隔的板块名(如"新能源车,光伏")，不传则全部'},
            },
        },
    }, category='insights')

    register('wm_trade_ideas', _wm_trade_ideas, {
        'name': 'wm_trade_ideas',
        'description': '基于三域跨域信号生成AI交易建议(BUY/SELL/WATCH)，含置信度和理由',
        'parameters': {
            'type': 'object',
            'properties': {
                'user_id': {'type': 'string', 'description': '用户ID(可选，个性化建议)'},
            },
        },
    }, category='insights')

    logger.warning(f'Registered {len(_tools)} tools: {list(_tools.keys())}')
