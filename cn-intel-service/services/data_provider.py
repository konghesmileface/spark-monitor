"""Unified data provider: akshare (primary) + tushare (secondary) + eastmoney HTTP (fallback).

All data goes through Redis DB 2 with trading-hours-aware TTL.
akshare calls eastmoney internally but wraps more data sources and handles parsing.
"""

import json
import logging
import math
import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests

logger = logging.getLogger('cn-intel.data_provider')

# --- Optional imports (fail gracefully) ---
_ak = None
_ts_api = None

def _init_akshare():
    global _ak
    if _ak is not None:
        return _ak
    try:
        import akshare as ak
        _ak = ak
        logger.warning('akshare loaded OK')
    except ImportError:
        _ak = False
        logger.warning('akshare not installed, using eastmoney HTTP fallback only')
    return _ak

def _init_tushare():
    global _ts_api
    if _ts_api is not None:
        return _ts_api
    try:
        from config import Config
        token = Config.TUSHARE_TOKEN
        if not token:
            _ts_api = False
            return _ts_api
        import tushare as ts
        ts.set_token(token)
        _ts_api = ts.pro_api()
        logger.warning('tushare pro_api loaded OK')
    except Exception as e:
        _ts_api = False
        logger.warning(f'tushare init failed: {e}')
    return _ts_api


# --- Trading hours detection ---

def _is_trading_hours():
    """Check if current time is within A-share trading hours (Mon-Fri 9:15-15:05)."""
    now = datetime.now()
    if now.weekday() >= 5:  # Saturday, Sunday
        return False
    t = now.hour * 100 + now.minute
    return 915 <= t <= 1505


def _get_ttl(trading_ttl, non_trading_ttl):
    """Return appropriate TTL based on trading hours."""
    return trading_ttl if _is_trading_hours() else non_trading_ttl


# --- Redis helpers (work outside Flask app context) ---

_redis_client = None

def _set_redis_client(r):
    """Store Redis client for bg threads (no Flask context)."""
    global _redis_client
    _redis_client = r
    logger.warning(f'data_provider: Redis client stored for bg threads')

def _redis():
    """Get Redis client — stored client (bg threads) or Flask context."""
    if _redis_client is not None:
        return _redis_client
    try:
        from flask import current_app
        return current_app.redis
    except Exception:
        return None


def _cache_get(key):
    """Get from Redis, return parsed JSON or None."""
    r = _redis()
    if not r:
        return None
    try:
        val = r.get(key)
        if val:
            return json.loads(val)
    except Exception:
        pass
    return None


def _cache_set(key, value, ttl):
    """Set JSON value in Redis with TTL."""
    r = _redis()
    if not r:
        return
    try:
        r.setex(key, ttl, json.dumps(value, ensure_ascii=False, default=str))
    except Exception as e:
        logger.warning(f'Redis SET failed for {key}: {e}')


def _cache_set_stale(key, value):
    """Save a long-lived stale copy for fallback when live data fails.
    Uses {key}:last with 7-day TTL."""
    r = _redis()
    if not r:
        return
    try:
        r.setex(f'{key}:last', 604800, json.dumps(value, ensure_ascii=False, default=str))
    except Exception:
        pass


def _cache_get_stale(key):
    """Get stale copy from Redis ({key}:last). Used when live data + normal cache both fail."""
    r = _redis()
    if not r:
        return None
    try:
        val = r.get(f'{key}:last')
        if val:
            return json.loads(val)
    except Exception:
        pass
    return None



# Eastmoney HTTPS→HTTP downgrade patch (called from app.py create_app)
_original_session_request = None

def _install_eastmoney_http_downgrade():
    """Monkey-patch requests.Session.request() to downgrade eastmoney HTTPS→HTTP.
    akshare internally uses HTTPS for push2*.eastmoney.com, but through proxy
    nodes, HTTP works better. Same pattern as FinGPT akshare_cache.py."""
    import requests as _req
    global _original_session_request
    if _original_session_request is not None:
        return  # Already installed
    _original_session_request = _req.Session.request

    def _patched_request(self, method, url, **kwargs):
        if isinstance(url, str) and 'eastmoney.com' in url and url.startswith('https://'):
            if 'push2' in url or 'datacenter' in url:
                url = 'http://' + url[8:]
        return _original_session_request(self, method, url, **kwargs)

    _req.Session.request = _patched_request
    logger.warning('Installed eastmoney HTTPS->HTTP downgrade patch (Session.request)')

# --- eastmoney HTTP fallback (same as akshare_data.py) ---

_PUSH2 = 'http://push2.eastmoney.com/api/qt'
_DATACENTER = 'http://datacenter-web.eastmoney.com/api/data/v1/get'
_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'http://quote.eastmoney.com/',
}
# Let eastmoney requests go through HTTP_PROXY (Clash) — cloud IP is blocked
_NO_PROXY = None
_TIMEOUT = 10

# --- In-memory spot cache (avoids repeated 60-page HTTP fetches) ---
_spot_mem = []
_spot_mem_ts = 0
_spot_lock = threading.Lock()
_bg_started = False


def _fetch_spot_raw():
    """Fetch full A-share spot data via eastmoney HTTP. Returns list or []."""
    all_items = []
    try:
        for page in range(1, 60):
            resp = requests.get(
                f'{_PUSH2}/clist/get',
                params={
                    'pn': str(page), 'pz': '100', 'po': '1', 'np': '1',
                    'fltt': '2', 'invt': '2', 'fid': 'f3',
                    'fs': 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
                    'fields': 'f2,f3,f4,f5,f6,f7,f8,f9,f12,f14',
                },
                headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
            )
            data = resp.json()
            diff = (data.get('data') or {}).get('diff')
            if not diff:
                break
            for item in diff:
                all_items.append({
                    'code': str(item.get('f12', '')),
                    'name': str(item.get('f14', '')),
                    'price': _safe_float(item.get('f2', 0)),
                    'changePercent': _safe_float(item.get('f3', 0)),
                    'change': _safe_float(item.get('f4', 0)),
                    'volume': _safe_float(item.get('f5', 0)),
                    'amount': _safe_float(item.get('f6', 0)),
                    'amplitude': _safe_float(item.get('f7', 0)),
                    'turnover': _safe_float(item.get('f8', 0)),
                    'pe': _safe_float(item.get('f9', 0)),
                })
            if len(diff) < 100:
                break
    except Exception as e:
        logger.warning(f'_fetch_spot_raw failed: {e}')
    return all_items


def _bg_spot_loop():
    """Background thread: refresh spot every 30s during trading hours.
    Uses Redis lock to ensure only one gunicorn worker actually fetches."""
    global _spot_mem, _spot_mem_ts
    while True:
        try:
            if _is_trading_hours():
                # Leader election: only one worker fetches at a time
                r = _redis()
                if r and not r.set('cn:bg:spot:lock', os.getpid(), ex=45, nx=True):
                    time.sleep(30)
                    continue
                data = _fetch_spot_raw()
                if data:
                    with _spot_lock:
                        _spot_mem = data
                        _spot_mem_ts = time.time()
                    _cache_set('cn:ak:spot', data, 30)
                time.sleep(30)
            else:
                time.sleep(120)
        except Exception as e:
            logger.warning(f'bg spot loop error: {e}')
            time.sleep(30)


def start_bg_refresh():
    """Start background spot data refresh thread. Call once at app startup."""
    global _bg_started
    if _bg_started:
        return
    _bg_started = True
    t = threading.Thread(target=_bg_spot_loop, daemon=True, name='spot-refresh')
    t.start()
    logger.warning('Background spot refresh thread started')


# ============================================================
#  1. get_a_spot() — Full A-share real-time quotes
# ============================================================

def get_a_spot():
    """Get full A-share spot data. In-memory → Redis → HTTP fallback."""
    global _spot_mem, _spot_mem_ts
    # 1. In-memory (fastest, updated by bg thread)
    with _spot_lock:
        if _spot_mem and (time.time() - _spot_mem_ts < 40):
            return _spot_mem

    # 2. Redis cache
    cache_key = 'cn:ak:spot'
    ttl = _get_ttl(600, 21600)

    if not _is_trading_hours():
        cached = _cache_get(cache_key)
        if cached:
            return cached

    # 3. Fetch from API
    all_items = _fetch_spot_raw()
    if all_items:
        with _spot_lock:
            _spot_mem = all_items
            _spot_mem_ts = time.time()
        _cache_set(cache_key, all_items, ttl)
        _cache_set_stale(cache_key, all_items)
        logger.warning(f'get_a_spot: {len(all_items)} stocks')
        return all_items

    # 4. Stale cache fallback (long-lived copy)
    stale = _cache_get_stale(cache_key)
    if stale:
        logger.warning(f'get_a_spot: using stale data ({len(stale)} stocks)')
        return stale
    return []


# ============================================================
#  2. get_stock_quote(code) — Single stock real-time quote
# ============================================================

def get_stock_quote(code):
    """Get single stock quote by code (e.g. '600519'). Returns dict or None."""
    code = str(code).strip()
    cache_key = f'cn:ak:quote:{code}'
    ttl = _get_ttl(600, 21600)

    if not _is_trading_hours():
        cached = _cache_get(cache_key)
        if cached:
            return cached

    # Try akshare individual quote
    ak = _init_akshare()
    if ak and ak is not False:
        try:
            df = ak.stock_individual_info_em(symbol=code)
            if df is not None and not df.empty:
                info = {}
                for _, row in df.iterrows():
                    key = str(row.get('item', ''))
                    val = row.get('value', '')
                    info[key] = val

                # Also get real-time price from bid data
                try:
                    bid_df = ak.stock_bid_ask_em(symbol=code)
                    if bid_df is not None and not bid_df.empty:
                        bid_info = {}
                        for _, r in bid_df.iterrows():
                            bid_info[str(r.get('item', ''))] = r.get('value', '')
                        info['_bid'] = bid_info
                except Exception:
                    pass

                result = {
                    'code': code,
                    'name': str(info.get('股票简称', info.get('名称', ''))),
                    'industry': str(info.get('行业', '')),
                    'totalMv': _safe_float(info.get('总市值', 0)),
                    'circulatingMv': _safe_float(info.get('流通市值', 0)),
                    'pe': _safe_float(info.get('市盈率(动态)', 0)),
                    'pb': _safe_float(info.get('市净率', 0)),
                    'totalShares': _safe_float(info.get('总股本', 0)),
                    'listingDate': str(info.get('上市时间', '')),
                }
                _cache_set(cache_key, result, ttl)
                return result
        except Exception as e:
            logger.warning(f'akshare stock_individual_info_em({code}) failed: {e}')

    # Fallback: search in spot data
    spots = get_a_spot()
    for s in spots:
        if s.get('code') == code:
            _cache_set(cache_key, s, ttl)
            return s

    return None


def _safe_float(val):
    """Safely convert value to float."""
    try:
        if val is None or val == '' or val == '-':
            return 0.0
        return float(val)
    except (ValueError, TypeError):
        return 0.0


# ============================================================
#  3. get_stock_hist(code, period, days) — Historical K-line
# ============================================================

def get_stock_hist(code, period='daily', days=60):
    """Get historical K-line data. period: 'daily'/'weekly'/'monthly'.
    Returns list of dicts: [{date, open, high, low, close, volume, amount}, ...]"""
    code = str(code).strip()
    cache_key = f'cn:ak:hist:{code}:{period}'
    ttl = _get_ttl(3600, 86400)

    cached = _cache_get(cache_key)
    if cached:
        return cached[:days] if len(cached) > days else cached

    ak = _init_akshare()
    if ak and ak is not False:
        try:
            end_date = datetime.now().strftime('%Y%m%d')
            start_date = (datetime.now() - timedelta(days=days * 2)).strftime('%Y%m%d')  # extra buffer
            df = ak.stock_zh_a_hist(
                symbol=code, period=period, start_date=start_date,
                end_date=end_date, adjust='qfq',
            )
            if df is not None and not df.empty:
                records = []
                for _, row in df.iterrows():
                    records.append({
                        'date': str(row.get('日期', '')),
                        'open': float(row.get('开盘', 0) or 0),
                        'high': float(row.get('最高', 0) or 0),
                        'low': float(row.get('最低', 0) or 0),
                        'close': float(row.get('收盘', 0) or 0),
                        'volume': float(row.get('成交量', 0) or 0),
                        'amount': float(row.get('成交额', 0) or 0),
                        'changePercent': float(row.get('涨跌幅', 0) or 0),
                        'turnover': float(row.get('换手率', 0) or 0),
                    })
                _cache_set(cache_key, records, ttl)
                return records[-days:] if len(records) > days else records
        except Exception as e:
            logger.warning(f'akshare hist({code}) failed: {e}')

    # Fallback: eastmoney kline API
    try:
        # Determine market prefix
        secid = f'1.{code}' if code.startswith('6') else f'0.{code}'
        klt_map = {'daily': '101', 'weekly': '102', 'monthly': '103'}
        klt = klt_map.get(period, '101')
        end_date = datetime.now().strftime('%Y%m%d')
        start_date = (datetime.now() - timedelta(days=days * 2)).strftime('%Y%m%d')

        resp = requests.get(
            f'http://push2his.eastmoney.com/api/qt/stock/kline/get',
            params={
                'secid': secid, 'klt': klt, 'fqt': '1',
                'beg': start_date, 'end': end_date,
                'fields1': 'f1,f2,f3,f4,f5,f6',
                'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
            },
            headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json()
        klines = (data.get('data') or {}).get('klines', [])
        records = []
        for line in klines:
            parts = line.split(',')
            if len(parts) >= 7:
                records.append({
                    'date': parts[0],
                    'open': float(parts[1]),
                    'close': float(parts[2]),
                    'high': float(parts[3]),
                    'low': float(parts[4]),
                    'volume': float(parts[5]),
                    'amount': float(parts[6]),
                    'changePercent': float(parts[8]) if len(parts) > 8 else 0,
                    'turnover': float(parts[10]) if len(parts) > 10 else 0,
                })
        if records:
            _cache_set(cache_key, records, ttl)
        return records[-days:] if len(records) > days else records
    except Exception as e:
        logger.warning(f'eastmoney hist fallback({code}) failed: {e}')

    return []


# ============================================================
#  4. get_north_flow() — Northbound capital net inflow
# ============================================================

def get_north_flow():
    """Get northbound capital (沪深港通) real net inflow.
    Returns dict: {shFlow, szFlow, totalFlow, direction, unit:'万元'}"""
    cache_key = 'cn:ak:north'
    ttl = _get_ttl(600, 21600)

    if not _is_trading_hours():
        cached = _cache_get(cache_key)
        if cached:
            return cached

    ak = _init_akshare()
    if ak and ak is not False:
        try:
            # stock_hsgt_fund_flow_summary_em returns today's northbound flow summary
            df = ak.stock_hsgt_fund_flow_summary_em()
            if df is not None and not df.empty:
                # Filter for 北向 rows (沪股通 + 深股通)
                sh_row = df[(df['板块'] == '沪股通') & (df['资金方向'] == '北向')]
                sz_row = df[(df['板块'] == '深股通') & (df['资金方向'] == '北向')]
                sh_flow = float(sh_row.iloc[0]['成交净买额']) if not sh_row.empty else 0
                sz_flow = float(sz_row.iloc[0]['成交净买额']) if not sz_row.empty else 0
                total = sh_flow + sz_flow
                # 成交净买额 unit is 亿元, convert to 万元 for consistency
                result = {
                    'totalFlow': total * 10000,  # 亿→万
                    'shFlow': sh_flow * 10000,
                    'szFlow': sz_flow * 10000,
                    'direction': 'inflow' if total > 0 else 'outflow',
                    'unit': '万元',
                    'source': 'akshare',
                }
                # Since 2024-08, northbound net buy data is no longer disclosed
                # (成交净买额 = 0 always). Add stock performance counts as alternative.
                if total == 0 and not sh_row.empty:
                    sh_up = int(sh_row.iloc[0].get('上涨数', 0) or 0)
                    sh_down = int(sh_row.iloc[0].get('下跌数', 0) or 0)
                    sz_up = int(sz_row.iloc[0].get('上涨数', 0) or 0) if not sz_row.empty else 0
                    sz_down = int(sz_row.iloc[0].get('下跌数', 0) or 0) if not sz_row.empty else 0
                    result['upStocks'] = sh_up + sz_up
                    result['downStocks'] = sh_down + sz_down
                    result['dataNote'] = '成交净买额暂停披露'
                _cache_set(cache_key, result, ttl)
                _cache_set_stale(cache_key, result)
                return result
        except Exception as e:
            logger.warning(f'akshare north flow failed: {e}')

    # Fallback 2: eastmoney kamt.rtmin API
    # fields: f51=time, f52=沪股通净流入, f53=沪股通余额, f54=深股通净流入, f55=深股通余额, f56=北向合计
    try:
        resp = requests.get(
            f'{_PUSH2}/kamt.rtmin/get',
            params={'fields1': 'f1,f2,f3,f4', 'fields2': 'f51,f52,f53,f54,f55,f56'},
            headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json()
        s2n = data.get('data', {}).get('s2n', [])
        sh_flow = sz_flow = 0
        for entry in reversed(s2n):
            parts = entry.split(',')
            if len(parts) >= 6 and parts[1] != '-':
                sh_flow = float(parts[1])
                sz_flow = float(parts[3]) if parts[3] != '-' else 0
                break
        total = sh_flow + sz_flow
        if total != 0:
            result = {
                'totalFlow': total,
                'shFlow': sh_flow,
                'szFlow': sz_flow,
                'direction': 'inflow' if total > 0 else 'outflow',
                'unit': '万元',
                'source': 'eastmoney_rtmin',
            }
            _cache_set(cache_key, result, ttl)
            _cache_set_stale(cache_key, result)
            return result
    except Exception as e:
        logger.warning(f'eastmoney north flow fallback failed: {e}')

    # Fallback 3: tushare moneyflow_hsgt (historical, available after market close)
    ts = _init_tushare()
    if ts and ts is not False:
        try:
            end = datetime.now().strftime('%Y%m%d')
            start = (datetime.now() - timedelta(days=5)).strftime('%Y%m%d')
            df = ts.moneyflow_hsgt(start_date=start, end_date=end)
            if df is not None and not df.empty:
                row = df.iloc[0]  # Most recent
                # north_money is total northbound net buy (万元)
                north = float(row.get('north_money', 0) or 0)
                hgt = float(row.get('hgt', 0) or 0)  # 沪股通 net buy
                sgt = float(row.get('sgt', 0) or 0)  # 深股通 net buy
                result = {
                    'totalFlow': north,
                    'shFlow': hgt,
                    'szFlow': sgt,
                    'direction': 'inflow' if north > 0 else 'outflow',
                    'unit': '万元',
                    'date': str(row.get('trade_date', '')),
                    'source': 'tushare',
                }
                _cache_set(cache_key, result, ttl)
                _cache_set_stale(cache_key, result)
                return result
        except Exception as e:
            logger.warning(f'tushare north flow failed: {e}')

    # Stale fallback — last known good data
    stale = _cache_get_stale(cache_key)
    if stale:
        logger.warning('get_north_flow: using stale data')
        _cache_set(cache_key, stale, _get_ttl(600, 21600))
        return stale
    return {'totalFlow': 0, 'shFlow': 0, 'szFlow': 0, 'direction': 'neutral', 'unit': '万元'}


# ============================================================
#  5. get_margin_data() — Margin trading data
# ============================================================

def get_margin_data():
    """Get margin trading (融资融券) data.
    Returns dict: {balance, prevBalance, change, date, source}"""
    cache_key = 'cn:ak:margin'
    ttl = _get_ttl(1800, 21600)

    cached = _cache_get(cache_key)
    if cached:
        return cached

    ak = _init_akshare()
    if ak and ak is not False:
        try:
            # macro_china_market_margin_sh returns full history, take last 2 rows
            df = ak.macro_china_market_margin_sh()
            if df is not None and len(df) >= 2:
                latest = df.iloc[-1]
                prev = df.iloc[-2]
                balance = float(latest.get('融资余额', 0) or 0)
                prev_balance = float(prev.get('融资余额', 0) or 0)
                result = {
                    'balance': balance,
                    'prevBalance': prev_balance,
                    'change': balance - prev_balance,
                    'date': str(latest.get('日期', ''))[:10],
                    'source': 'akshare',
                }
                _cache_set(cache_key, result, ttl)
                return result
        except Exception as e:
            logger.warning(f'akshare margin failed: {e}')

    # Fallback: eastmoney datacenter
    try:
        resp = requests.get(
            _DATACENTER,
            params={
                'reportName': 'RPTA_WEB_RZRQ_ZCZJMX',
                'columns': 'ALL',
                'pageSize': '3', 'pageNumber': '1',
                'sortColumns': 'DIM_DATE', 'sortTypes': '-1',
                'source': 'WEB', 'client': 'WEB',
            },
            headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'http://data.eastmoney.com/'},
            timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json()
        items = data.get('result', {}).get('data', [])
        if items and len(items) >= 2:
            balance = float(items[0].get('RZYE', 0) or 0)
            prev_balance = float(items[1].get('RZYE', 0) or 0)
            result = {
                'balance': balance,
                'prevBalance': prev_balance,
                'change': balance - prev_balance,
                'date': str(items[0].get('DIM_DATE', ''))[:10],
                'source': 'eastmoney',
            }
            _cache_set(cache_key, result, ttl)
            return result
    except Exception as e:
        logger.warning(f'eastmoney margin fallback failed: {e}')

    return {'balance': 0, 'prevBalance': 0, 'change': 0, 'date': '', 'source': 'none'}


# ============================================================
#  6. get_stock_info(code) — Stock basic info (tushare + akshare)
# ============================================================

def get_stock_info(code):
    """Get stock basic info (PE/PB/industry/company). Tushare free → akshare fallback.
    Returns dict or None."""
    code = str(code).strip()
    cache_key = f'cn:ts:info:{code}'
    ttl = 86400  # 24h for static info

    cached = _cache_get(cache_key)
    if cached:
        return cached

    # Tushare daily_basic (free tier: works for PE/PB)
    ts = _init_tushare()
    if ts and ts is not False:
        try:
            # Convert code: 600519 → 600519.SH
            if code.startswith('6') or code.startswith('9'):
                ts_code = f'{code}.SH'
            else:
                ts_code = f'{code}.SZ'
            df = ts.daily_basic(ts_code=ts_code, fields='ts_code,trade_date,pe_ttm,pb,total_mv,circ_mv')
            if df is not None and not df.empty:
                row = df.iloc[0]
                result = {
                    'code': code,
                    'pe': float(row.get('pe_ttm', 0) or 0),
                    'pb': float(row.get('pb', 0) or 0),
                    'totalMv': float(row.get('total_mv', 0) or 0) * 10000,  # tushare unit is 万元
                    'circulatingMv': float(row.get('circ_mv', 0) or 0) * 10000,
                    'source': 'tushare',
                }
                _cache_set(cache_key, result, ttl)
                return result
        except Exception as e:
            logger.warning(f'tushare daily_basic({code}) failed: {e}')

    # Fallback: get from spot data
    quote = get_stock_quote(code)
    if quote:
        result = {
            'code': code,
            'name': quote.get('name', ''),
            'pe': quote.get('pe', 0),
            'pb': quote.get('pb', 0),
            'totalMv': quote.get('totalMv', 0),
            'industry': quote.get('industry', ''),
            'source': 'akshare',
        }
        _cache_set(cache_key, result, ttl)
        return result

    return None


# ============================================================
#  7. get_fund_flow(code) — Individual stock fund flow
# ============================================================

def get_fund_flow(code):
    """Get individual stock fund flow (主力/散户 net inflow).
    Returns dict: {mainNetInflow, mainPct, retailNetInflow, superlarge, large, medium, small, date}"""
    code = str(code).strip()
    cache_key = f'cn:ak:flow:{code}'
    ttl = _get_ttl(600, 21600)

    if not _is_trading_hours():
        cached = _cache_get(cache_key)
        if cached:
            return cached

    ak = _init_akshare()
    if ak and ak is not False:
        try:
            df = ak.stock_individual_fund_flow(stock=code, market='sh' if code.startswith('6') else 'sz')
            if df is not None and not df.empty:
                last = df.iloc[-1]
                result = {
                    'code': code,
                    'date': str(last.get('日期', ''))[:10],
                    'mainNetInflow': float(last.get('主力净流入-净额', 0) or 0),
                    'mainPct': float(last.get('主力净流入-净占比', 0) or 0),
                    'superlargeInflow': float(last.get('超大单净流入-净额', 0) or 0),
                    'largeInflow': float(last.get('大单净流入-净额', 0) or 0),
                    'mediumInflow': float(last.get('中单净流入-净额', 0) or 0),
                    'smallInflow': float(last.get('小单净流入-净额', 0) or 0),
                    'source': 'akshare',
                }
                _cache_set(cache_key, result, ttl)
                return result
        except Exception as e:
            logger.warning(f'akshare fund_flow({code}) failed: {e}')

    # Fallback: eastmoney fund flow API
    try:
        secid = f'1.{code}' if code.startswith('6') else f'0.{code}'
        resp = requests.get(
            f'http://push2.eastmoney.com/api/qt/stock/fflow/daykline/get',
            params={
                'secid': secid,
                'fields1': 'f1,f2,f3,f7',
                'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
                'lmt': '1',
            },
            headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json()
        klines = (data.get('data') or {}).get('klines', [])
        if klines:
            parts = klines[-1].split(',')
            # Format: date,主力净流入,小单净流入,中单净流入,大单净流入,超大单净流入,
            #         主力占比,小单占比,中单占比,大单占比,超大单占比,收盘,涨跌幅,...
            if len(parts) >= 6:
                result = {
                    'code': code,
                    'date': parts[0],
                    'mainNetInflow': float(parts[1]),
                    'mainPct': float(parts[6]) if len(parts) > 6 else 0,
                    'superlargeInflow': float(parts[5]),
                    'largeInflow': float(parts[4]),
                    'mediumInflow': float(parts[3]),
                    'smallInflow': float(parts[2]),
                    'source': 'eastmoney',
                }
                _cache_set(cache_key, result, ttl)
                return result
    except Exception as e:
        logger.warning(f'eastmoney fund flow fallback({code}) failed: {e}')

    return None


# ============================================================
#  8. get_sector_rank() — Sector/industry board ranking
# ============================================================

def get_sector_rank(top_n=10):
    """Get industry sector ranking (涨幅排名). Returns list of dicts.
    Sources: eastmoney clist/get → tushare sw_daily → stale cache."""
    cache_key = 'cn:ak:sector'
    ttl = _get_ttl(600, 21600)

    if not _is_trading_hours():
        cached = _cache_get(cache_key)
        if cached:
            return cached[:top_n]

    # Source 1: eastmoney direct HTTP (fastest during trading hours)
    try:
        resp = requests.get(
            f'{_PUSH2}/clist/get',
            params={
                'pn': '1', 'pz': str(top_n), 'po': '1', 'np': '1',
                'fltt': '2', 'invt': '2', 'fid': 'f3',
                'fs': 'm:90+t:2',
                'fields': 'f2,f3,f4,f12,f14,f128,f136',
            },
            headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        if resp.status_code == 200 and resp.text:
            data = resp.json()
            records = []
            if (data.get('data') or {}).get('diff'):
                for item in data['data']['diff']:
                    records.append({
                        'name': str(item.get('f14', '')),
                        'changePercent': float(item.get('f3', 0)),
                        'leadStock': str(item.get('f128', '')),
                        'amount': float(item.get('f136', 0) or 0),
                    })
            if records:
                _cache_set(cache_key, records, ttl)
                _cache_set_stale(cache_key, records)
                return records
    except Exception as e:
        logger.warning(f'eastmoney sector failed: {e}')

    # Source 2: tushare SW L1 industry index (申万一级行业)
    ts = _init_tushare()
    if ts and ts is not False:
        try:
            records = _get_sector_rank_tushare(ts, top_n)
            if records:
                _cache_set(cache_key, records, ttl)
                _cache_set_stale(cache_key, records)
                return records
        except Exception as e:
            logger.warning(f'tushare sector failed: {e}')

    # Stale fallback
    stale = _cache_get_stale(cache_key)
    if stale:
        logger.warning('get_sector_rank: using stale data')
        return stale[:top_n]
    return []


# SW L1 industry codes (cached after first fetch)
_sw_l1_codes = None


def _get_sector_rank_tushare(ts_api, top_n=10):
    """Get sector ranking from tushare sw_daily (申万一级行业指数)."""
    global _sw_l1_codes
    # Get SW L1 codes if not cached
    if _sw_l1_codes is None:
        try:
            df_class = ts_api.index_classify(level='L1', src='SW2021')
            if df_class is not None and not df_class.empty:
                _sw_l1_codes = set(df_class['index_code'].tolist())
                logger.warning(f'Loaded {len(_sw_l1_codes)} SW L1 industry codes')
        except Exception:
            pass
    if not _sw_l1_codes:
        return []

    # Try today first, then recent trading days
    for days_back in range(0, 5):
        trade_date = (datetime.now() - timedelta(days=days_back)).strftime('%Y%m%d')
        try:
            df = ts_api.sw_daily(trade_date=trade_date)
            if df is not None and not df.empty:
                # Filter for L1 industry indices only
                df_l1 = df[df['ts_code'].isin(_sw_l1_codes)].copy()
                if df_l1.empty:
                    continue
                df_l1 = df_l1.sort_values('pct_change', ascending=False)
                records = []
                for _, row in df_l1.head(top_n).iterrows():
                    records.append({
                        'name': str(row.get('name', '')),
                        'changePercent': float(row.get('pct_change', 0) or 0),
                        'leadStock': '',
                        'amount': float(row.get('amount', 0) or 0),
                    })
                if records:
                    logger.warning(f'tushare sector: {len(records)} sectors from {trade_date}')
                    return records
        except Exception:
            continue
    return []


# ============================================================
#  Utility: compute limit stats from spot data
# ============================================================

def compute_limit_stats(spots=None):
    """Compute up/down/flat/limitUp/limitDown from full spot data.
    Falls back to tushare daily() if spot data unavailable or incomplete."""
    if spots is None:
        spots = get_a_spot()
    # Need at least 1000 stocks for reliable stats; partial data skews results
    if not spots or len(spots) < 1000:
        stats = _get_limit_stats_tushare()
        if stats:
            return stats
        if not spots:
            return {'up': 0, 'down': 0, 'flat': 0, 'limitUp': 0, 'limitDown': 0}

    up = down = flat = limit_up = limit_down = 0
    for s in spots:
        pct = s.get('changePercent', 0)
        if pct > 0:
            up += 1
        elif pct < 0:
            down += 1
        else:
            flat += 1
        if pct >= 9.9:
            limit_up += 1
        if pct <= -9.9:
            limit_down += 1

    return {
        'up': up, 'down': down, 'flat': flat,
        'limitUp': limit_up, 'limitDown': limit_down,
    }


def _get_limit_stats_tushare():
    """Get limit stats from tushare daily(). Only works after market close."""
    cache_key = 'cn:ts:limit_stats'
    cached = _cache_get(cache_key)
    if cached:
        return cached

    ts = _init_tushare()
    if not ts or ts is False:
        return None

    # Try recent trading days
    for days_back in range(0, 5):
        trade_date = (datetime.now() - timedelta(days=days_back)).strftime('%Y%m%d')
        try:
            df = ts.daily(trade_date=trade_date, fields='ts_code,pct_chg')
            if df is not None and not df.empty:
                up = int(len(df[df['pct_chg'] > 0]))
                down = int(len(df[df['pct_chg'] < 0]))
                flat = int(len(df[df['pct_chg'] == 0]))
                limit_up = int(len(df[df['pct_chg'] >= 9.9]))
                limit_down = int(len(df[df['pct_chg'] <= -9.9]))
                stats = {
                    'up': up, 'down': down, 'flat': flat,
                    'limitUp': limit_up, 'limitDown': limit_down,
                    'date': trade_date, 'source': 'tushare',
                }
                ttl = _get_ttl(1800, 21600)
                _cache_set(cache_key, stats, ttl)
                logger.warning(f'tushare limit stats from {trade_date}: up={up} down={down} limitUp={limit_up} limitDown={limit_down}')
                return stats
        except Exception:
            continue
    return None


# ============================================================
#  9. get_macro_indicators() — CPI/PPI/PMI via akshare
# ============================================================

def get_macro_indicators():
    """Get macro economic indicators (CPI, PPI, PMI). Returns dict."""
    cache_key = 'cn:ak:macro'
    ttl = 86400  # Daily data, 24h cache

    cached = _cache_get(cache_key)
    if cached:
        return cached

    result = {'cpi': [], 'ppi': [], 'pmi': [], 'source': 'akshare'}

    ak = _init_akshare()
    if not ak or ak is False:
        return result

    # CPI — year-over-year
    try:
        df = ak.macro_china_cpi()
        if df is not None and not df.empty:
            for _, row in df.tail(12).iterrows():
                result['cpi'].append({
                    'date': str(row.iloc[0])[:10] if len(df.columns) > 0 else '',
                    'value': float(row.iloc[1]) if len(df.columns) > 1 else 0,
                })
    except Exception as e:
        logger.warning(f'akshare CPI failed: {e}')

    # PPI
    try:
        df = ak.macro_china_ppi()
        if df is not None and not df.empty:
            for _, row in df.tail(12).iterrows():
                result['ppi'].append({
                    'date': str(row.iloc[0])[:10] if len(df.columns) > 0 else '',
                    'value': float(row.iloc[1]) if len(df.columns) > 1 else 0,
                })
    except Exception as e:
        logger.warning(f'akshare PPI failed: {e}')

    # PMI — Manufacturing PMI
    try:
        df = ak.macro_china_pmi()
        if df is not None and not df.empty:
            for _, row in df.tail(12).iterrows():
                result['pmi'].append({
                    'date': str(row.iloc[0])[:10] if len(df.columns) > 0 else '',
                    'value': float(row.iloc[1]) if len(df.columns) > 1 else 0,
                })
    except Exception as e:
        logger.warning(f'akshare PMI failed: {e}')

    if result['cpi'] or result['ppi'] or result['pmi']:
        _cache_set(cache_key, result, ttl)
    return result


# ============================================================
#  10. get_technical_indicators(code, days) — RSI/MACD/Bollinger
# ============================================================

def get_technical_indicators(code, days=60):
    """Calculate technical indicators from K-line. Pure Python, no TA-Lib.
    Returns dict with rsi14, macd, bollinger, sma5, sma20."""
    code = str(code).strip()
    cache_key = f'cn:ak:tech:{code}'
    ttl = _get_ttl(1800, 86400)

    cached = _cache_get(cache_key)
    if cached:
        return cached

    klines = get_stock_hist(code, period='daily', days=max(days, 60))
    if not klines or len(klines) < 20:
        return {'code': code, 'error': '历史数据不足，无法计算技术指标'}

    closes = [k['close'] for k in klines]

    # --- RSI (14-day) ---
    rsi_values = _calc_rsi(closes, 14)

    # --- MACD (12, 26, 9) ---
    macd_line, signal_line, histogram = _calc_macd(closes, 12, 26, 9)

    # --- Bollinger Bands (20-day, 2 std dev) ---
    upper, middle, lower = _calc_bollinger(closes, 20, 2)

    # --- SMA 5 and 20 ---
    sma5 = _calc_sma(closes, 5)
    sma20 = _calc_sma(closes, 20)

    # Build result (last N values)
    n = min(len(klines), days)
    result = {
        'code': code,
        'days': n,
        'indicators': [],
    }
    for i in range(max(0, len(klines) - n), len(klines)):
        entry = {
            'date': klines[i]['date'],
            'close': closes[i],
        }
        if i < len(rsi_values):
            entry['rsi14'] = round(rsi_values[i], 2)
        if i < len(macd_line):
            entry['macd'] = round(macd_line[i], 4)
            entry['signal'] = round(signal_line[i], 4)
            entry['histogram'] = round(histogram[i], 4)
        if i < len(upper):
            entry['boll_upper'] = round(upper[i], 2)
            entry['boll_middle'] = round(middle[i], 2)
            entry['boll_lower'] = round(lower[i], 2)
        if i < len(sma5):
            entry['sma5'] = round(sma5[i], 2)
        if i < len(sma20):
            entry['sma20'] = round(sma20[i], 2)
        result['indicators'].append(entry)

    # Summary (latest values)
    latest = result['indicators'][-1] if result['indicators'] else {}
    result['summary'] = {
        'rsi14': latest.get('rsi14', 50),
        'macd': latest.get('macd', 0),
        'signal': latest.get('signal', 0),
        'histogram': latest.get('histogram', 0),
        'boll_upper': latest.get('boll_upper', 0),
        'boll_middle': latest.get('boll_middle', 0),
        'boll_lower': latest.get('boll_lower', 0),
        'close': latest.get('close', 0),
        'sma5': latest.get('sma5', 0),
        'sma20': latest.get('sma20', 0),
    }

    # Signal interpretation
    rsi = result['summary']['rsi14']
    if rsi >= 70:
        result['summary']['rsi_signal'] = '超买'
    elif rsi <= 30:
        result['summary']['rsi_signal'] = '超卖'
    else:
        result['summary']['rsi_signal'] = '中性'

    hist = result['summary']['histogram']
    result['summary']['macd_signal'] = '多头' if hist > 0 else '空头'

    close = result['summary']['close']
    boll_mid = result['summary']['boll_middle']
    if close > result['summary']['boll_upper']:
        result['summary']['boll_signal'] = '突破上轨'
    elif close < result['summary']['boll_lower']:
        result['summary']['boll_signal'] = '跌破下轨'
    elif close > boll_mid:
        result['summary']['boll_signal'] = '中轨上方'
    else:
        result['summary']['boll_signal'] = '中轨下方'

    result['summary']['ma_signal'] = '多头排列' if result['summary']['sma5'] > result['summary']['sma20'] else '空头排列'

    _cache_set(cache_key, result, ttl)
    return result


def _calc_rsi(closes, period=14):
    """Calculate RSI using Wilder's smoothing."""
    rsi = [50.0] * len(closes)
    if len(closes) <= period:
        return rsi
    gains = []
    losses = []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(closes)):
        if i > period:
            avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        if avg_loss == 0:
            rsi[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi[i] = 100 - 100 / (1 + rs)
    return rsi


def _calc_ema(data, period):
    """Exponential Moving Average."""
    ema = [0.0] * len(data)
    if len(data) < period:
        return ema
    multiplier = 2 / (period + 1)
    ema[period - 1] = sum(data[:period]) / period
    for i in range(period, len(data)):
        ema[i] = (data[i] - ema[i - 1]) * multiplier + ema[i - 1]
    return ema


def _calc_sma(data, period):
    """Simple Moving Average."""
    sma = [0.0] * len(data)
    for i in range(period - 1, len(data)):
        sma[i] = sum(data[i - period + 1:i + 1]) / period
    return sma


def _calc_macd(closes, fast=12, slow=26, signal_period=9):
    """Calculate MACD line, signal line, histogram."""
    ema_fast = _calc_ema(closes, fast)
    ema_slow = _calc_ema(closes, slow)
    macd_line = [ema_fast[i] - ema_slow[i] for i in range(len(closes))]
    signal_line = _calc_ema(macd_line, signal_period)
    histogram = [macd_line[i] - signal_line[i] for i in range(len(closes))]
    return macd_line, signal_line, histogram


def _calc_bollinger(closes, period=20, num_std=2):
    """Calculate Bollinger Bands."""
    upper = [0.0] * len(closes)
    middle = [0.0] * len(closes)
    lower = [0.0] * len(closes)
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1:i + 1]
        mean = sum(window) / period
        variance = sum((x - mean) ** 2 for x in window) / period
        std = math.sqrt(variance)
        middle[i] = mean
        upper[i] = mean + num_std * std
        lower[i] = mean - num_std * std
    return upper, middle, lower


# ============================================================
#  11. get_sector_rotation(top_n) — Sector rotation analysis
# ============================================================

def get_sector_rotation(top_n=20):
    """Compare current sector performance vs 5-day average.
    Identifies sectors with accelerating/decelerating momentum.
    Returns list sorted by momentum change."""
    cache_key = 'cn:ak:sector_rotation'
    ttl = _get_ttl(1800, 21600)

    cached = _cache_get(cache_key)
    if cached:
        return cached

    # Get current sector data (more than default top 10)
    try:
        resp = requests.get(
            f'{_PUSH2}/clist/get',
            params={
                'pn': '1', 'pz': str(top_n), 'po': '1', 'np': '1',
                'fltt': '2', 'invt': '2', 'fid': 'f3',
                'fs': 'm:90+t:2',
                'fields': 'f2,f3,f4,f8,f12,f14,f104,f105,f128,f136',
            },
            headers=_HEADERS, timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json()
        sectors = []
        if (data.get('data') or {}).get('diff'):
            for item in data['data']['diff']:
                sectors.append({
                    'code': str(item.get('f12', '')),
                    'name': str(item.get('f14', '')),
                    'changePercent': _safe_float(item.get('f3', 0)),
                    'turnover': _safe_float(item.get('f8', 0)),
                    'upCount': int(item.get('f104', 0) or 0),
                    'downCount': int(item.get('f105', 0) or 0),
                    'leadStock': str(item.get('f128', '')),
                    'amount': _safe_float(item.get('f136', 0)),
                })
    except Exception as e:
        logger.warning(f'sector rotation fetch failed: {e}')
        return {'sectors': [], 'timestamp': datetime.now().isoformat()}

    # Get 5-day history for each sector to calculate momentum
    ak = _init_akshare()
    hist_map = {}
    if ak and ak is not False:
        for s in sectors[:top_n]:
            try:
                df = ak.stock_board_industry_hist_em(
                    symbol=s['name'], period='日k',
                    start_date=(datetime.now() - timedelta(days=10)).strftime('%Y%m%d'),
                    end_date=datetime.now().strftime('%Y%m%d'),
                    adjust='',
                )
                if df is not None and len(df) >= 2:
                    changes = [float(row.get('涨跌幅', 0) or 0) for _, row in df.tail(5).iterrows()]
                    hist_map[s['name']] = changes
            except Exception:
                pass  # Skip sectors where history fails

    # Calculate momentum: current change vs 5-day avg
    result_sectors = []
    for s in sectors:
        hist = hist_map.get(s['name'], [])
        avg_5d = sum(hist) / len(hist) if hist else 0
        momentum = s['changePercent'] - avg_5d
        breadth = s['upCount'] / max(s['upCount'] + s['downCount'], 1) * 100

        status = 'neutral'
        if momentum > 1:
            status = 'accelerating'
        elif momentum < -1:
            status = 'decelerating'
        elif s['changePercent'] > 1:
            status = 'strong'
        elif s['changePercent'] < -1:
            status = 'weak'

        result_sectors.append({
            'name': s['name'],
            'changePercent': s['changePercent'],
            'avg5d': round(avg_5d, 2),
            'momentum': round(momentum, 2),
            'breadth': round(breadth, 1),
            'turnover': s['turnover'],
            'leadStock': s['leadStock'],
            'amount': s['amount'],
            'status': status,
        })

    # Sort by momentum (most accelerating first)
    result_sectors.sort(key=lambda x: x['momentum'], reverse=True)

    result = {
        'sectors': result_sectors,
        'inflow': [s for s in result_sectors if s['status'] == 'accelerating'][:5],
        'outflow': [s for s in result_sectors if s['status'] == 'decelerating'][:5],
        'timestamp': datetime.now().isoformat(),
    }
    _cache_set(cache_key, result, ttl)
    return result


# ============================================================
#  12. get_stock_batch(codes) — Batch stock quotes
# ============================================================

def get_stock_batch(codes):
    """Get batch stock quotes. codes: list of stock codes. Returns list of dicts."""
    if not codes:
        return []

    # Try to serve from spot cache first (fastest)
    spots = get_a_spot()
    spot_map = {s['code']: s for s in spots} if spots else {}

    results = []
    missing_codes = []

    for code in codes[:20]:  # Limit to 20 stocks per batch
        code = str(code).strip()
        if code in spot_map:
            results.append(spot_map[code])
        else:
            # Try Redis cache
            cached = _cache_get(f'cn:ak:quote:{code}')
            if cached:
                results.append(cached)
            else:
                missing_codes.append(code)

    # Fetch missing ones in parallel (max 5 concurrent)
    if missing_codes:
        def _fetch_one(c):
            return get_stock_quote(c)

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {executor.submit(_fetch_one, c): c for c in missing_codes}
            for future in as_completed(futures, timeout=15):
                try:
                    data = future.result()
                    if data:
                        results.append(data)
                except Exception:
                    pass

    return results
