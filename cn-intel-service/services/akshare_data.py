"""A-share market data via direct HTTP to eastmoney APIs.
No akshare dependency — works without curl_cffi."""

import json
import logging
import requests
import traceback
import pymysql
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

logger = logging.getLogger('cn-intel.market')

# eastmoney API base URLs
_PUSH2 = 'http://push2.eastmoney.com/api/qt'
_REPORT_API = 'http://reportapi.eastmoney.com/report'
_DATACENTER = 'http://datacenter-web.eastmoney.com/api/data/v1/get'

_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'http://quote.eastmoney.com/',
}

_TIMEOUT = 10

# Let eastmoney requests go through HTTP_PROXY (Clash) — cloud IP is blocked by eastmoney
_NO_PROXY = None


def _get_total_by_filter(filter_expr):
    """Get total count of stocks matching a filter using single API call.
    Uses pz=1 and reads data.total for the count."""
    try:
        resp = requests.get(
            f'{_PUSH2}/clist/get',
            params={
                'pn': '1',
                'pz': '1',
                'po': '1',
                'np': '1',
                'fltt': '2',
                'invt': '2',
                'fid': 'f3',
                'fs': 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
                'fields': 'f3',
                'fid0': 'f3',
                'filter': filter_expr,
            },
            headers=_HEADERS,
            timeout=8,
            proxies=_NO_PROXY,
        )
        data = resp.json()
        return data.get('data', {}).get('total', 0)
    except Exception:
        return 0


def get_market_overview():
    """Get A-share market overview: indices, sectors, northbound flow, limit stats.
    Uses data_provider for spot/north/sectors when available, falls back to direct HTTP.
    During non-trading hours, returns None to let the route handler use stale cache."""
    from services.cache import is_trading_time
    if not is_trading_time():
        logger.debug('get_market_overview: non-trading hours, returning None for stale cache fallback')
        return None

    from services.data_provider import get_a_spot, get_north_flow, get_sector_rank, compute_limit_stats

    result = {
        'indices': [],
        'sectors': [],
        'northbound': {'total': 0, 'shConnect': 0, 'szConnect': 0, 'direction': 'neutral', 'type': 'net_flow'},
        'limitStats': {'limitUp': 0, 'limitDown': 0, 'up': 0, 'down': 0, 'flat': 0},
        'timestamp': datetime.now().isoformat()
    }

    # 1. Major indices via ulist API (keep direct HTTP — fast, index-specific)
    try:
        resp = requests.get(
            f'{_PUSH2}/ulist.np/get',
            params={
                'fltt': '2',
                'secids': '1.000001,0.399001,0.399006,1.000688',
                'fields': 'f2,f3,f4,f5,f6,f12,f14',
            },
            headers=_HEADERS,
            timeout=_TIMEOUT,
            proxies=_NO_PROXY,
        )
        data = resp.json()
        if data.get('data') and data['data'].get('diff'):
            name_map = {
                '000001': ('上证指数', 'sh000001'),
                '399001': ('深证成指', 'sz399001'),
                '399006': ('创业板指', 'sz399006'),
                '000688': ('科创50', 'sh000688'),
            }
            for item in data['data']['diff']:
                code = str(item.get('f12', ''))
                if code in name_map:
                    zh_name, full_code = name_map[code]
                    result['indices'].append({
                        'name': zh_name,
                        'code': full_code,
                        'price': float(item.get('f2', 0)),
                        'change': float(item.get('f4', 0)),
                        'changePercent': float(item.get('f3', 0)),
                        'volume': float(item.get('f5', 0)),
                        'amount': float(item.get('f6', 0)),
                    })
            # Sort to stable order
            order = ['sh000001', 'sz399001', 'sz399006', 'sh000688']
            result['indices'].sort(key=lambda x: order.index(x['code']) if x['code'] in order else 99)
    except Exception as e:
        logger.warning(f'Failed to get indices: {e}')

    # 1b. Tushare fallback for indices if eastmoney failed
    if not result['indices']:
        try:
            from services.data_provider import _init_tushare
            ts = _init_tushare()
            if ts and ts is not False:
                _INDEX_MAP = {
                    '000001.SH': ('上证指数', 'sh000001'),
                    '399001.SZ': ('深证成指', 'sz399001'),
                    '399006.SZ': ('创业板指', 'sz399006'),
                    '000688.SH': ('科创50', 'sh000688'),
                }
                from datetime import timedelta as _td
                start = (datetime.now() - _td(days=5)).strftime('%Y%m%d')
                for ts_code, (zh_name, full_code) in _INDEX_MAP.items():
                    try:
                        df = ts.index_daily(ts_code=ts_code, start_date=start)
                        if df is not None and not df.empty:
                            row = df.iloc[0]
                            result['indices'].append({
                                'name': zh_name,
                                'code': full_code,
                                'price': float(row.get('close', 0) or 0),
                                'change': float(row.get('change', 0) or 0),
                                'changePercent': float(row.get('pct_chg', 0) or 0),
                                'volume': float(row.get('vol', 0) or 0),
                                'amount': float(row.get('amount', 0) or 0),
                            })
                    except Exception:
                        pass
                if result['indices']:
                    logger.warning(f'tushare indices: {len(result["indices"])} indices')
        except Exception as e:
            logger.warning(f'tushare indices fallback failed: {e}')

    # 2-4. Parallel fetch: sectors + northbound + spot data
    sectors_result = []
    north_result = None
    spots = None

    def _fetch_sectors():
        return get_sector_rank(top_n=10)

    def _fetch_north():
        return get_north_flow()

    def _fetch_spots():
        return get_a_spot()

    with ThreadPoolExecutor(max_workers=3) as executor:
        f_sectors = executor.submit(_fetch_sectors)
        f_north = executor.submit(_fetch_north)
        f_spots = executor.submit(_fetch_spots)

        try:
            sectors_result = f_sectors.result(timeout=25) or []
        except Exception as e:
            logger.warning(f'Failed to get sectors: {e}')
        try:
            north_result = f_north.result(timeout=25)
        except Exception as e:
            logger.warning(f'Failed to get northbound: {e}')
        try:
            spots = f_spots.result(timeout=25)
        except Exception as e:
            logger.warning(f'Failed to get spot data: {e}')

    # Apply results
    if sectors_result:
        result['sectors'] = sectors_result

    if north_result:
        total_flow = north_result.get('totalFlow', 0)
        total_yuan = total_flow * 10000 if abs(total_flow) < 1e8 else total_flow
        result['northbound'] = {
            'total': total_yuan,
            'shConnect': (north_result.get('shFlow', 0) or 0) * (10000 if abs(north_result.get('shFlow', 0) or 0) < 1e8 else 1),
            'szConnect': (north_result.get('szFlow', 0) or 0) * (10000 if abs(north_result.get('szFlow', 0) or 0) < 1e8 else 1),
            'direction': north_result.get('direction', 'neutral'),
            'type': 'net_flow',
        }
        # Pass through stock performance data when flow not disclosed
        if 'upStocks' in north_result:
            result['northbound']['upStocks'] = north_result['upStocks']
            result['northbound']['downStocks'] = north_result['downStocks']
            result['northbound']['dataNote'] = north_result.get('dataNote', '')

    # 4. Limit up/down stats — compute_limit_stats handles spot→tushare fallback
    result['limitStats'] = compute_limit_stats(spots)

    # 5. Top gainers/losers — from spot data or tushare fallback
    try:
        if spots and len(spots) >= 1000:
            sorted_up = sorted([s for s in spots if s.get('changePercent', 0) > 0],
                               key=lambda x: x['changePercent'], reverse=True)
            sorted_down = sorted([s for s in spots if s.get('changePercent', 0) < 0],
                                 key=lambda x: x['changePercent'])
            result['topGainers'] = [{'code': s['code'], 'name': s['name'],
                                     'price': s['price'], 'changePercent': s['changePercent']}
                                    for s in sorted_up[:5]]
            result['topLosers'] = [{'code': s['code'], 'name': s['name'],
                                    'price': s['price'], 'changePercent': s['changePercent']}
                                   for s in sorted_down[:5]]
        else:
            movers = get_top_movers()
            result['topGainers'] = movers.get('gainers', [])
            result['topLosers'] = movers.get('losers', [])
    except Exception as e:
        logger.warning(f'Failed to get top movers: {e}')

    # 5b. Tushare fallback for top movers if eastmoney failed
    if not result.get('topGainers') and not result.get('topLosers'):
        try:
            movers = _get_top_movers_tushare()
            result['topGainers'] = movers.get('gainers', [])
            result['topLosers'] = movers.get('losers', [])
        except Exception as e:
            logger.warning(f'tushare top movers fallback failed: {e}')

    return result


def get_top_movers():
    """Get top 5 gainers and top 5 losers from A-share market."""
    result = {'gainers': [], 'losers': []}
    fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'

    def _fetch_movers(po):
        """po=1 descending (gainers), po=0 ascending (losers)"""
        try:
            resp = requests.get(
                f'{_PUSH2}/clist/get',
                params={
                    'pn': '1', 'pz': '5', 'po': str(po), 'np': '1',
                    'fltt': '2', 'invt': '2', 'fid': 'f3',
                    'fs': fs,
                    'fields': 'f2,f3,f12,f14',
                },
                headers=_HEADERS,
                timeout=_TIMEOUT,
                proxies=_NO_PROXY,
            )
            data = resp.json()
            items = []
            if data.get('data') and data['data'].get('diff'):
                for item in data['data']['diff']:
                    items.append({
                        'code': str(item.get('f12', '')),
                        'name': str(item.get('f14', '')),
                        'price': float(item.get('f2', 0)),
                        'changePercent': float(item.get('f3', 0)),
                    })
            return items
        except Exception as e:
            logger.warning(f'Failed to get top movers (po={po}): {e}')
            return []

    result['gainers'] = _fetch_movers(1)
    result['losers'] = _fetch_movers(0)
    return result


_ts_name_map = None


def _get_ts_name_map(ts_api):
    """Build ts_code → name mapping from tushare stock_basic(). Cached in memory."""
    global _ts_name_map
    if _ts_name_map is not None:
        return _ts_name_map
    try:
        df = ts_api.stock_basic(fields='ts_code,name')
        if df is not None and not df.empty:
            _ts_name_map = dict(zip(df['ts_code'], df['name']))
            return _ts_name_map
    except Exception:
        pass
    _ts_name_map = {}
    return _ts_name_map


def _get_top_movers_tushare():
    """Get top gainers/losers from tushare daily() as fallback."""
    from services.data_provider import _init_tushare
    ts = _init_tushare()
    if not ts or ts is False:
        return {'gainers': [], 'losers': []}

    name_map = _get_ts_name_map(ts)
    from datetime import timedelta
    for days_back in range(0, 5):
        trade_date = (datetime.now() - timedelta(days=days_back)).strftime('%Y%m%d')
        try:
            df = ts.daily(trade_date=trade_date, fields='ts_code,close,pct_chg')
            if df is not None and not df.empty:
                # Top 5 gainers
                top_up = df.nlargest(5, 'pct_chg')
                gainers = []
                for _, row in top_up.iterrows():
                    ts_code = str(row.get('ts_code', ''))
                    code = ts_code.split('.')[0] if '.' in ts_code else ts_code
                    gainers.append({
                        'code': code,
                        'name': name_map.get(ts_code, ''),
                        'price': float(row.get('close', 0) or 0),
                        'changePercent': float(row.get('pct_chg', 0) or 0),
                    })
                # Top 5 losers
                top_down = df.nsmallest(5, 'pct_chg')
                losers = []
                for _, row in top_down.iterrows():
                    ts_code = str(row.get('ts_code', ''))
                    code = ts_code.split('.')[0] if '.' in ts_code else ts_code
                    losers.append({
                        'code': code,
                        'name': name_map.get(ts_code, ''),
                        'price': float(row.get('close', 0) or 0),
                        'changePercent': float(row.get('pct_chg', 0) or 0),
                    })
                logger.warning(f'tushare top movers from {trade_date}')
                return {'gainers': gainers, 'losers': losers}
        except Exception:
            continue
    return {'gainers': [], 'losers': []}


def _get_sentiment_redis():
    """Get Redis instance from Flask app context for sentiment history."""
    try:
        from flask import current_app
        return current_app.redis
    except Exception:
        return None


def _save_sentiment_history(score):
    """Save sentiment score to Redis sorted set for real trend tracking."""
    r = _get_sentiment_redis()
    if not r:
        return
    try:
        key = 'cn:sentiment:history'
        now = datetime.now()
        ts = now.timestamp()
        date_str = now.strftime('%Y-%m-%d')
        value = json.dumps({'date': date_str, 'score': score})
        # Use date as member to deduplicate (one score per day)
        r.zadd(key, {value: ts})
        # Keep only last 30 days
        cutoff = ts - 30 * 86400
        r.zremrangebyscore(key, 0, cutoff)
    except Exception as e:
        logger.warning(f'Failed to save sentiment history: {e}')


def _load_sentiment_history():
    """Load real sentiment trend from Redis."""
    r = _get_sentiment_redis()
    if not r:
        return []
    try:
        key = 'cn:sentiment:history'
        items = r.zrangebyscore(key, '-inf', '+inf')
        trend = []
        for item in items:
            try:
                d = json.loads(item)
                trend.append({'date': d['date'], 'score': d['score']})
            except Exception:
                continue
        # Deduplicate by date, keep last value
        seen = {}
        for t in trend:
            seen[t['date']] = t
        return sorted(seen.values(), key=lambda x: x['date'])[-7:]  # Last 7 days
    except Exception as e:
        logger.warning(f'Failed to load sentiment history: {e}')
        return []


def get_sentiment_data():
    """Calculate market sentiment index from real data.
    Uses data_provider for spot/north/margin — reduces HTTP calls from 7 to 2-3.
    During non-trading hours, returns None to let the route handler use stale cache."""
    from services.cache import is_trading_time
    if not is_trading_time():
        return None

    from services.data_provider import get_a_spot, get_north_flow, get_margin_data, compute_limit_stats
    factors = []
    overall_score = 50

    # Pre-fetch spot data (one call powers Factor 1 + Factor 2 + Factor 4)
    spots = None
    try:
        spots = get_a_spot()
    except Exception as e:
        logger.warning(f'get_a_spot for sentiment failed: {e}')

    # Factor 1: Up/down ratio — from spot data (0 extra HTTP calls)
    try:
        if spots:
            stats = compute_limit_stats(spots)
            up_count = stats['up']
            down_count = stats['down']
            total = up_count + down_count
            ratio_score = int(up_count / total * 100) if total > 0 else 50
            factors.append({'name': '涨跌比', 'score': ratio_score, 'detail': f'{up_count}涨/{down_count}跌'})
        else:
            up_count = _get_total_by_filter('(f3>0)')
            down_count = _get_total_by_filter('(f3<0)')
            total = up_count + down_count
            ratio_score = int(up_count / total * 100) if total > 0 else 50
            factors.append({'name': '涨跌比', 'score': ratio_score, 'detail': f'{up_count}涨/{down_count}跌'})
    except Exception:
        factors.append({'name': '涨跌比', 'score': 50, 'detail': '数据获取中'})

    # Factor 2: Volume — from spot data (sh total amount) or index API
    try:
        if spots:
            # Sum amount for Shanghai stocks (code starts with 6)
            sh_amount = sum(s.get('amount', 0) for s in spots if s.get('code', '').startswith('6'))
            baseline = 1e12
            vol_ratio = sh_amount / baseline if baseline > 0 else 1.0
            vol_score = min(100, max(0, int(vol_ratio * 50)))
            amount_yi = sh_amount / 1e8
            factors.append({'name': '成交量', 'score': vol_score, 'detail': f'沪市成交{amount_yi:.0f}亿'})
        else:
            resp = requests.get(
                f'{_PUSH2}/ulist.np/get',
                params={'fltt': '2', 'secids': '1.000001', 'fields': 'f6'},
                headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
            )
            data = resp.json()
            if data.get('data') and data['data'].get('diff'):
                amount = float(data['data']['diff'][0].get('f6', 0))
                vol_score = min(100, max(0, int(amount / 1e12 * 50)))
                factors.append({'name': '成交量', 'score': vol_score, 'detail': f'沪市成交{amount/1e8:.0f}亿'})
            else:
                factors.append({'name': '成交量', 'score': 50, 'detail': '数据获取中'})
    except Exception:
        factors.append({'name': '成交量', 'score': 50, 'detail': '数据获取中'})

    # Factor 3: Northbound flow — via data_provider (real net inflow)
    try:
        north = get_north_flow()
        net_flow = north.get('totalFlow', 0)
        # net_flow is in 万元
        flow_yi = net_flow / 1e4
        flow_score = min(100, max(0, 50 + int(flow_yi * 2)))
        factors.append({'name': '北向资金', 'score': flow_score, 'detail': f'{flow_yi:.1f}亿'})
    except Exception:
        factors.append({'name': '北向资金', 'score': 50, 'detail': '数据获取中'})

    # Factor 4: Volatility — from index change (direct HTTP, fast)
    try:
        resp = requests.get(
            f'{_PUSH2}/ulist.np/get',
            params={'fltt': '2', 'secids': '1.000001', 'fields': 'f3'},
            headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json()
        if data.get('data') and data['data'].get('diff'):
            change_pct = abs(float(data['data']['diff'][0].get('f3', 0)))
            if change_pct < 0.5:
                vol_score = 55
            elif change_pct < 1.0:
                vol_score = 45
            elif change_pct < 2.0:
                vol_score = 35
            else:
                vol_score = 25
            factors.append({'name': '波动率', 'score': vol_score, 'detail': f'振幅 {change_pct:.1f}%'})
        else:
            factors.append({'name': '波动率', 'score': 50, 'detail': '数据获取中'})
    except Exception:
        factors.append({'name': '波动率', 'score': 50, 'detail': '数据获取中'})

    # Factor 5: Margin trading — via data_provider (akshare → eastmoney fallback)
    try:
        margin = get_margin_data()
        balance = margin.get('balance', 0)
        change = margin.get('change', 0)
        if balance > 0:
            balance_yi = balance / 1e8
            change_yi = change / 1e8
            if change > 0:
                margin_score = min(80, 55 + int(change_yi * 5))
            else:
                margin_score = max(20, 45 + int(change_yi * 5))
            sign = '+' if change >= 0 else ''
            factors.append({
                'name': '融资融券',
                'score': margin_score,
                'detail': f'融资余额{balance_yi:.0f}亿 {sign}{change_yi:.1f}亿'
            })
        else:
            factors.append({'name': '融资融券', 'score': 52, 'detail': '暂无数据'})
    except Exception as e:
        logger.warning(f'Margin trading data failed: {e}')
        factors.append({'name': '融资融券', 'score': 52, 'detail': '数据获取中'})

    # Calculate overall
    if factors:
        overall_score = int(sum(f['score'] for f in factors) / len(factors))

    # Label
    if overall_score >= 80:
        label = '极度贪婪'
    elif overall_score >= 60:
        label = '贪婪'
    elif overall_score >= 40:
        label = '中性'
    elif overall_score >= 20:
        label = '恐惧'
    else:
        label = '极度恐惧'

    # Save to history for real trend tracking
    _save_sentiment_history(overall_score)

    # 7-day trend — from real Redis history only (no PRNG fallback)
    trend = _load_sentiment_history()

    return {
        'score': overall_score,
        'label': label,
        'factors': factors,
        'trend': trend,
        'timestamp': datetime.now().isoformat()
    }


def get_research_reports():
    """Get latest research reports from eastmoney report API."""
    reports = []
    try:
        resp = requests.get(
            f'{_REPORT_API}/list',
            params={
                'industryCode': '*',
                'pageSize': '20',
                'industry': '*',
                'rating': '*',
                'ratingChange': '*',
                'beginTime': '',
                'endTime': '',
                'pageNo': '1',
                'fields': '',
                'qType': '0',
                'orgCode': '',
                'code': '*',
                'rcode': '',
                'p': '1',
                'pageNum': '1',
                'pageNumber': '1',
                '_': str(int(datetime.now().timestamp() * 1000)),
            },
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'http://data.eastmoney.com/',
            },
            timeout=_TIMEOUT,
            proxies=_NO_PROXY,
        )
        data = resp.json()
        items = data.get('data', [])
        if items:
            for idx, item in enumerate(items[:20]):
                institution = str(item.get('orgSName', item.get('orgName', '')))
                stock_name = str(item.get('stockName', ''))
                rating = str(item.get('sRatingName', '中性'))
                industry = str(item.get('industryName', ''))
                title = str(item.get('title', ''))

                # Enhanced summary: combine institution + stock + rating + industry
                summary_parts = []
                if institution:
                    summary_parts.append(f'{institution}发布研报')
                if stock_name:
                    summary_parts.append(f'标的: {stock_name}')
                if rating and rating != '中性':
                    summary_parts.append(f'评级: {rating}')
                if industry:
                    summary_parts.append(f'行业: {industry}')
                summary = ', '.join(summary_parts) if summary_parts else title

                info_code = str(item.get('infoCode', ''))
                pdf_link = f'https://pdf.dfcfw.com/pdf/H3_{info_code}_1.pdf' if info_code else ''

                reports.append({
                    'id': f'rpt_{idx}',
                    'title': title,
                    'institution': institution,
                    'rating': rating,
                    'industry': industry,
                    'stockName': stock_name,
                    'stockCode': str(item.get('stockCode', '')),
                    'date': str(item.get('publishDate', ''))[:10],
                    'summary': summary,
                    'link': pdf_link,
                    'infoCode': info_code,
                    'attachPages': item.get('attachPages'),
                })
    except Exception as e:
        logger.warning(f'Failed to get research reports: {e}\n{traceback.format_exc()}')

    industries = list(set(r['industry'] for r in reports if r.get('industry')))
    industries.sort()

    return {
        'reports': reports,
        'industries': industries,
        'timestamp': datetime.now().isoformat()
    }


# --- Remote MySQL research report database ---
from config import Config
_MYSQL_CONFIG = {
    'host': Config.MYSQL_HOST,
    'port': Config.MYSQL_PORT,
    'user': Config.MYSQL_USER,
    'password': Config.MYSQL_PASSWORD,
    'database': Config.MYSQL_DATABASE,
    'charset': 'utf8mb4',
    'connect_timeout': 10,
    'read_timeout': 15,
}


_TYPE_LABELS = {
    '0': '快讯', '01': '监管', '02': '金融处罚', '03': '央行动态',
    '04': '研报', '05': '自媒体', '06': '海外', '99': '其他',
}


def get_db_research_reports(page=1, page_size=30, keyword='', doc_type='all'):
    """Get research reports from remote MySQL database.
    doc_type: 'all' (04+05), '04' (研报 only), '05' (自媒体 only).
    Default: only last 7 days (unless keyword search spans all time)."""
    from services.db_pool import get_connection
    from datetime import timedelta
    reports = []
    total = 0
    sources = []
    try:
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                # Build WHERE clause
                if doc_type == '04':
                    where = "type = '04'"
                elif doc_type == '05':
                    where = "type = '05'"
                else:
                    where = "type IN ('04', '05')"
                params = []

                # Default 7-day window when no keyword search
                if keyword:
                    where += " AND (info_title LIKE %s OR media LIKE %s OR resume LIKE %s)"
                    like = f'%{keyword}%'
                    params.extend([like, like, like])
                else:
                    cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
                    where += " AND news_date >= %s"
                    params.append(cutoff)

                # Total count
                cur.execute(f"SELECT COUNT(*) as cnt FROM news WHERE {where}", params)
                total = cur.fetchone()['cnt']

                # Paginated list — lightweight fields only (no macro_array)
                offset = (page - 1) * page_size
                cur.execute(
                    f"""SELECT id, info_title, news_date, media,
                               LEFT(resume, 300) as resume,
                               link_address, industry_array, secu_array_stock,
                               emotion, type
                        FROM news
                        WHERE {where}
                        ORDER BY news_date DESC, id DESC
                        LIMIT %s OFFSET %s""",
                    params + [page_size, offset],
                )
                rows = cur.fetchall()

                for row in rows:
                    date_val = row.get('news_date')
                    row_type = str(row.get('type') or '04')
                    reports.append({
                        'id': f'db_{row["id"]}',
                        'title': str(row.get('info_title') or ''),
                        'institution': str(row.get('media') or ''),
                        'date': str(date_val)[:10] if date_val else '',
                        'summary': str(row.get('resume') or ''),
                        'link': str(row.get('link_address') or ''),
                        'industry': str(row.get('industry_array') or ''),
                        'stocks': str(row.get('secu_array_stock') or ''),
                        'emotion': row.get('emotion'),
                        'type': row_type,
                        'typeLabel': _TYPE_LABELS.get(row_type, '其他'),
                    })

                # Get distinct sources (recent 30 days only for speed)
                type_cond = "type IN ('04','05')" if doc_type == 'all' else f"type='{doc_type}'"
                src_cutoff = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
                cur.execute(
                    f"SELECT media, COUNT(*) as cnt FROM news WHERE {type_cond} "
                    "AND news_date >= %s GROUP BY media ORDER BY cnt DESC LIMIT 20",
                    (src_cutoff,),
                )
                sources = [{'name': r['media'], 'count': r['cnt']} for r in cur.fetchall() if r['media']]
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'Failed to get DB research reports: {e}\n{traceback.format_exc()}')

    return {
        'reports': reports,
        'total': total,
        'page': page,
        'pageSize': page_size,
        'sources': sources,
        'timestamp': datetime.now().isoformat()
    }


def get_db_news_articles(page=1, page_size=30, keyword='', news_type='all'):
    """Get news articles (types 0/01/02/03) from remote MySQL for 舆情 panel.
    news_type: 'all' (0+01+02+03), '0', '01', '02', '03'.
    Default: last 7 days (keyword search spans all time)."""
    from services.db_pool import get_connection
    from datetime import timedelta
    articles = []
    total = 0
    try:
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                if news_type in ('0', '01', '02', '03'):
                    where = f"type = '{news_type}'"
                else:
                    where = "type IN ('0','01','02','03')"
                params = []
                if keyword:
                    where += " AND (info_title LIKE %s OR media LIKE %s OR resume LIKE %s)"
                    like = f'%{keyword}%'
                    params.extend([like, like, like])
                else:
                    cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
                    where += " AND news_date >= %s"
                    params.append(cutoff)

                cur.execute(f"SELECT COUNT(*) as cnt FROM news WHERE {where}", params)
                total = cur.fetchone()['cnt']

                offset = (page - 1) * page_size
                cur.execute(
                    f"""SELECT id, info_title, news_date, media, resume,
                               link_address, emotion, type,
                               LENGTH(macro_array) > 0 as has_content
                        FROM news WHERE {where}
                        ORDER BY news_date DESC, id DESC
                        LIMIT %s OFFSET %s""",
                    params + [page_size, offset],
                )
                for row in cur.fetchall():
                    row_type = str(row.get('type') or '99')
                    articles.append({
                        'id': f'db_{row["id"]}',
                        'title': str(row.get('info_title') or ''),
                        'source': str(row.get('media') or ''),
                        'date': str(row.get('news_date') or '')[:10],
                        'summary': str(row.get('resume') or ''),
                        'link': str(row.get('link_address') or ''),
                        'emotion': row.get('emotion'),
                        'type': row_type,
                        'typeLabel': _TYPE_LABELS.get(row_type, '其他'),
                        'hasContent': bool(row.get('has_content')),
                    })
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'Failed to get DB news articles: {e}\n{traceback.format_exc()}')

    return {
        'articles': articles,
        'total': total,
        'page': page,
        'pageSize': page_size,
        'timestamp': datetime.now().isoformat()
    }


def get_db_news_detail(article_id):
    """Get full news article detail from remote MySQL.
    Supports types 0/01/02/03. Returns full macro_array + plainText."""
    from services.db_pool import get_connection
    import re as _re
    numeric_id = str(article_id).replace('db_', '')
    try:
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    """SELECT id, info_title, news_date, media, resume,
                              link_address, macro_array, emotion, type
                       FROM news WHERE id = %s AND type IN ('0','01','02','03')""",
                    [numeric_id],
                )
                row = cur.fetchone()
                if not row:
                    return None

                content_html = str(row.get('macro_array') or '')
                # Strip HTML tags for plain text
                plain_text = _re.sub(r'<[^>]+>', '', content_html)
                plain_text = _re.sub(r'\s+', ' ', plain_text).strip()
                row_type = str(row.get('type') or '0')

                return {
                    'id': f'db_{row["id"]}',
                    'title': str(row.get('info_title') or ''),
                    'source': str(row.get('media') or ''),
                    'date': str(row.get('news_date') or '')[:10],
                    'summary': str(row.get('resume') or ''),
                    'content': content_html,
                    'plainText': plain_text,
                    'link': str(row.get('link_address') or ''),
                    'emotion': row.get('emotion'),
                    'type': row_type,
                    'typeLabel': _TYPE_LABELS.get(row_type, '其他'),
                }
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'Failed to get news detail {article_id}: {e}')
        return None


def search_db_research_reports(keywords, exclude_id='', limit=60):
    """Search research reports (types 04/05) by multiple keywords with scoring.
    Returns results grouped by year, sorted by relevance score."""
    from services.db_pool import get_connection
    if not keywords:
        return []
    try:
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                # Build OR conditions for each keyword
                like_conditions = []
                params = []
                for kw in keywords[:6]:
                    like_conditions.append("(info_title LIKE %s OR resume LIKE %s)")
                    like_val = f'%{kw}%'
                    params.extend([like_val, like_val])

                where = f"type IN ('04','05') AND ({' OR '.join(like_conditions)})"
                if exclude_id:
                    numeric_id = str(exclude_id).replace('db_', '')
                    where += " AND id != %s"
                    params.append(numeric_id)

                cur.execute(
                    f"""SELECT id, info_title, news_date, media, resume, type
                        FROM news
                        WHERE {where}
                        ORDER BY news_date DESC
                        LIMIT %s""",
                    params + [limit],
                )
                rows = cur.fetchall()

                # Score each result by keyword matches
                scored = []
                for row in rows:
                    title = str(row.get('info_title') or '')
                    resume = str(row.get('resume') or '')
                    score = 0
                    for kw in keywords:
                        if kw in title:
                            score += len(kw) * 2  # title match worth more
                        if kw in resume:
                            score += len(kw)
                    scored.append((score, row))

                scored.sort(key=lambda x: x[0], reverse=True)

                results = []
                for score, row in scored:
                    date_val = row.get('news_date')
                    date_str = str(date_val)[:10] if date_val else ''
                    results.append({
                        'id': f'db_{row["id"]}',
                        'title': str(row.get('info_title') or ''),
                        'date': date_str,
                        'source': str(row.get('media') or ''),
                        'type': str(row.get('type') or '04'),
                        'summary': str(row.get('resume') or '')[:200],
                    })
                return results
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'search_db_research_reports failed: {e}')
        return []


def get_db_report_detail(report_id):
    """Get full report detail from remote MySQL (no macro_array truncation).
    Supports type 04 (研报) and 05 (自媒体).
    Returns dict with full content + plain text version for AI prompts."""
    from services.db_pool import get_connection
    import re as _re
    numeric_id = str(report_id).replace('db_', '')
    try:
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    """SELECT id, info_title, news_date, media, resume,
                              link_address, macro_array, industry_array,
                              secu_array_stock, emotion, type
                       FROM news WHERE id = %s AND type IN ('04','05')""",
                    [numeric_id],
                )
                row = cur.fetchone()
                if not row:
                    return None

                content_html = str(row.get('macro_array') or '')
                # Strip HTML tags for AI context
                plain_text = _re.sub(r'<[^>]+>', '', content_html)
                plain_text = _re.sub(r'\s+', ' ', plain_text).strip()
                row_type = str(row.get('type') or '04')

                return {
                    'id': f'db_{row["id"]}',
                    'title': str(row.get('info_title') or ''),
                    'institution': str(row.get('media') or ''),
                    'date': str(row.get('news_date') or '')[:10],
                    'summary': str(row.get('resume') or ''),
                    'content': content_html,
                    'plainText': plain_text,
                    'link': str(row.get('link_address') or ''),
                    'industry': str(row.get('industry_array') or ''),
                    'stocks': str(row.get('secu_array_stock') or ''),
                    'emotion': row.get('emotion'),
                    'type': row_type,
                    'typeLabel': _TYPE_LABELS.get(row_type, '其他'),
                }
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'Failed to get report detail {report_id}: {e}')
        return None
