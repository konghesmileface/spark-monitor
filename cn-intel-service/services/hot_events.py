"""Hot events detection: market concept boards + social trending topics + DB news.
Fuses eastmoney concept board data with weibo/baidu/toutiao hot topics and DB news."""

import logging
import requests
import traceback
import pymysql
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

logger = logging.getLogger('cn-intel.events')

# ── A股实体词典 (市值前100+常见别名) ──
_STOCK_ALIASES = {
    # 白酒
    '贵州茅台': {'code': '600519', 'aliases': ['茅台', '贵茅', 'MOUTAI']},
    '五粮液': {'code': '000858', 'aliases': ['五粮', '五粮液酒']},
    '泸州老窖': {'code': '000568', 'aliases': ['老窖', '泸州']},
    '山西汾酒': {'code': '600809', 'aliases': ['汾酒']},
    # 银行
    '招商银行': {'code': '600036', 'aliases': ['招行', '招银']},
    '工商银行': {'code': '601398', 'aliases': ['工行', '宇宙行']},
    '建设银行': {'code': '601939', 'aliases': ['建行']},
    '中国银行': {'code': '601988', 'aliases': ['中行']},
    '农业银行': {'code': '601288', 'aliases': ['农行']},
    '兴业银行': {'code': '601166', 'aliases': ['兴业']},
    '中信银行': {'code': '601998', 'aliases': ['中信行']},
    '平安银行': {'code': '000001', 'aliases': ['平银']},
    # 保险
    '中国平安': {'code': '601318', 'aliases': ['平安', '中平']},
    '中国人寿': {'code': '601628', 'aliases': ['人寿', '国寿']},
    '中国太保': {'code': '601601', 'aliases': ['太保']},
    '新华保险': {'code': '601336', 'aliases': ['新华']},
    # 券商
    '中信证券': {'code': '600030', 'aliases': ['中信', '中信券商']},
    '海通证券': {'code': '600837', 'aliases': ['海通']},
    '华泰证券': {'code': '601688', 'aliases': ['华泰']},
    '国泰君安': {'code': '601211', 'aliases': ['国君']},
    '东方财富': {'code': '300059', 'aliases': ['东财', '东方']},
    # 科技
    '宁德时代': {'code': '300750', 'aliases': ['宁德', 'CATL', '宁王']},
    '比亚迪': {'code': '002594', 'aliases': ['BYD', '迪子', '迪王']},
    '隆基绿能': {'code': '601012', 'aliases': ['隆基', '隆基股份']},
    '通威股份': {'code': '600438', 'aliases': ['通威']},
    '阳光电源': {'code': '300274', 'aliases': ['阳光']},
    '中芯国际': {'code': '688981', 'aliases': ['中芯', 'SMIC']},
    '韦尔股份': {'code': '603501', 'aliases': ['韦尔']},
    '北方华创': {'code': '002371', 'aliases': ['华创', '北华创']},
    '海光信息': {'code': '688041', 'aliases': ['海光']},
    '中微公司': {'code': '688012', 'aliases': ['中微']},
    '寒武纪': {'code': '688256', 'aliases': ['寒武']},
    '科大讯飞': {'code': '002230', 'aliases': ['讯飞']},
    '紫光股份': {'code': '000938', 'aliases': ['紫光']},
    # 医药
    '恒瑞医药': {'code': '600276', 'aliases': ['恒瑞']},
    '药明康德': {'code': '603259', 'aliases': ['药明', 'WuXi']},
    '迈瑞医疗': {'code': '300760', 'aliases': ['迈瑞']},
    '片仔癀': {'code': '600436', 'aliases': ['片仔']},
    # 消费
    '伊利股份': {'code': '600887', 'aliases': ['伊利']},
    '海天味业': {'code': '603288', 'aliases': ['海天']},
    '美的集团': {'code': '000333', 'aliases': ['美的']},
    '格力电器': {'code': '000651', 'aliases': ['格力']},
    '海尔智家': {'code': '600690', 'aliases': ['海尔']},
    # 互联网/软件
    '腾讯控股': {'code': '00700', 'aliases': ['腾讯', 'Tencent']},
    '阿里巴巴': {'code': '09988', 'aliases': ['阿里', '淘宝', 'Alibaba']},
    '百度集团': {'code': '09888', 'aliases': ['百度', 'Baidu']},
    '京东集团': {'code': '09618', 'aliases': ['京东', 'JD']},
    '美团': {'code': '03690', 'aliases': ['美团点评']},
    '网易': {'code': '09999', 'aliases': ['NetEase']},
    '小米集团': {'code': '01810', 'aliases': ['小米', 'Xiaomi']},
    # 通信/运营商
    '中国移动': {'code': '600941', 'aliases': ['移动']},
    '中国电信': {'code': '601728', 'aliases': ['电信']},
    '中国联通': {'code': '600050', 'aliases': ['联通']},
    '中兴通讯': {'code': '000063', 'aliases': ['中兴']},
    # 能源/资源
    '中国石油': {'code': '601857', 'aliases': ['中石油', '两桶油']},
    '中国石化': {'code': '600028', 'aliases': ['中石化']},
    '中国神华': {'code': '601088', 'aliases': ['神华']},
    '紫金矿业': {'code': '601899', 'aliases': ['紫金']},
    '中国铝业': {'code': '601600', 'aliases': ['中铝']},
    '长江电力': {'code': '600900', 'aliases': ['长电']},
    # 军工
    '中航沈飞': {'code': '600760', 'aliases': ['沈飞']},
    '航发动力': {'code': '600893', 'aliases': ['航发']},
    '中国船舶': {'code': '600150', 'aliases': ['船舶', '中船']},
    # 地产
    '万科A': {'code': '000002', 'aliases': ['万科']},
    '保利发展': {'code': '600048', 'aliases': ['保利']},
    '招商蛇口': {'code': '001979', 'aliases': ['蛇口']},
    # 汽车
    '长城汽车': {'code': '601633', 'aliases': ['长城']},
    '长安汽车': {'code': '000625', 'aliases': ['长安']},
    '上汽集团': {'code': '600104', 'aliases': ['上汽']},
    '理想汽车': {'code': '02015', 'aliases': ['理想', 'Li Auto']},
    '蔚来': {'code': '09866', 'aliases': ['NIO', '蔚来汽车']},
    # 基建/建材
    '中国建筑': {'code': '601668', 'aliases': ['中建']},
    '中国中铁': {'code': '601390', 'aliases': ['中铁']},
    '海螺水泥': {'code': '600585', 'aliases': ['海螺']},
    # 指数
    '上证指数': {'code': '000001.SH', 'aliases': ['上证', '大盘', '沪指']},
    '深证成指': {'code': '399001.SZ', 'aliases': ['深证', '深指', '深成指']},
    '创业板指': {'code': '399006.SZ', 'aliases': ['创业板', '创指']},
    '科创50': {'code': '000688.SH', 'aliases': ['科创', '科创板']},
    '沪深300': {'code': '000300.SH', 'aliases': ['沪深三百']},
    '中证500': {'code': '000905.SH', 'aliases': ['中证五百']},
}

# Build reverse lookup: alias → (name, code). Skip aliases ≤ 1 char.
_ALIAS_TO_STOCK = {}
for _name, _info in _STOCK_ALIASES.items():
    _ALIAS_TO_STOCK[_name] = (_name, _info['code'])
    for _alias in _info.get('aliases', []):
        if len(_alias) >= 2:
            _ALIAS_TO_STOCK[_alias] = (_name, _info['code'])


def _extract_related_stocks(text):
    """Extract stock entities mentioned in text using alias dictionary.
    Returns list of {code, name} dicts, deduplicated."""
    if not text:
        return []
    found = {}
    for alias, (name, code) in _ALIAS_TO_STOCK.items():
        if alias in text and name not in found:
            found[name] = {'code': code, 'name': name}
    return list(found.values())[:5]  # Max 5 per event


_PUSH2 = 'http://push2.eastmoney.com/api/qt'
_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'http://quote.eastmoney.com/',
}
_TIMEOUT = 10
_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'


def _get_proxies():
    """Get proxy config from Config. Returns {} if no proxy configured."""
    from config import Config
    proxies = {}
    if Config.HTTP_PROXY:
        proxies['http'] = Config.HTTP_PROXY
    if Config.HTTPS_PROXY:
        proxies['https'] = Config.HTTPS_PROXY
    return proxies or None


def get_hot_events():
    """Get hot events from DB news + social trending + market concepts.
    Returns news-first ordering: DB news → social hot search → market concepts."""
    # Parallel fetch all three sources
    db_news_events = []
    market_events = []
    social_events = []

    with ThreadPoolExecutor(max_workers=3) as executor:
        f_db = executor.submit(_get_db_news_events)
        f_market = executor.submit(_get_market_events)
        f_social = executor.submit(_get_social_events)

        try:
            db_news_events = f_db.result(timeout=15)
        except Exception as e:
            logger.warning(f'DB news events failed: {e}')
        try:
            market_events = f_market.result(timeout=15)
        except Exception as e:
            logger.warning(f'Market events failed: {e}')
        try:
            social_events = f_social.result(timeout=15)
        except Exception as e:
            logger.warning(f'Social events failed: {e}')

    # News-first ordering
    events = db_news_events + social_events + market_events
    if not events:
        events = _fallback_events()

    return {
        'events': events,
        'timestamp': datetime.now().isoformat()
    }


# MySQL config from centralized Config
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


def _get_db_news_events():
    """Get recent important news from DB (type=0 综合新闻) as hot events."""
    events = []
    try:
        from services.db_pool import get_connection
        conn = get_connection()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                # Recent 3 days, top 10 by date
                cutoff = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')
                cur.execute(
                    """SELECT id, info_title, news_date, media, resume, emotion,
                              link_address
                       FROM news
                       WHERE type = '0' AND news_date >= %s
                       ORDER BY news_date DESC, id DESC
                       LIMIT 10""",
                    [cutoff],
                )
                for idx, row in enumerate(cur.fetchall()):
                    title = str(row.get('info_title') or '')
                    if not title:
                        continue
                    source = str(row.get('media') or '')
                    resume = str(row.get('resume') or '')
                    date_str = str(row.get('news_date') or '')[:10]
                    emotion = str(row.get('emotion') or '中性')
                    link = str(row.get('link_address') or '')

                    # Determine impact from emotion
                    impact = 'medium'
                    if emotion == '负面':
                        impact = 'high'
                    elif emotion == '正面':
                        impact = 'medium'

                    summary = resume[:120] if resume else ''

                    # Extract related stock entities from title + summary
                    stocks = _extract_related_stocks(title + ' ' + summary)

                    events.append({
                        'id': f'dbnews_{row["id"]}',
                        'title': title,
                        'summary': summary,
                        'keywords': [source] if source else [],
                        'relatedStocks': stocks,
                        'impact': impact,
                        'timestamp': date_str,
                        'source': source or '新闻数据库',
                        'type': 'db-news',
                        'url': link or None,
                        'emotion': emotion,
                    })
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'DB news events failed: {e}\n{traceback.format_exc()}')
    return events


def _market_snapshot_key():
    return 'cn:hot-events:market-snapshot'


def _save_market_snapshot(events):
    """Save last successful market events to Redis as fallback snapshot."""
    try:
        from flask import current_app
        r = current_app.redis
        if r and events:
            import json as _json
            r.setex(_market_snapshot_key(), 86400, _json.dumps(events, ensure_ascii=False))
    except Exception:
        pass


def _load_market_snapshot():
    """Load market events snapshot from Redis when live fetch fails."""
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            import json as _json
            val = r.get(_market_snapshot_key())
            if val:
                items = _json.loads(val)
                for item in items:
                    item['_stale'] = True
                return items
    except Exception:
        pass
    return []


def _get_market_events():
    """Get hot market events: eastmoney → akshare → tushare → Redis snapshot."""
    events = _get_market_events_eastmoney()
    if not events:
        logger.warning('eastmoney push2 failed, trying akshare fallback')
        events = _get_market_events_akshare()
    if not events:
        logger.warning('akshare failed, trying tushare fallback')
        events = _get_market_events_tushare()

    # Save successful fetch as snapshot, or fall back to snapshot
    if events:
        _save_market_snapshot(events)
    else:
        snapshot = _load_market_snapshot()
        if snapshot:
            logger.warning(f'Market events using Redis snapshot ({len(snapshot)} items)')
            events = snapshot

    return events


def _get_market_events_eastmoney():
    """Primary: eastmoney push2 API."""
    try:
        resp = requests.get(
            f'{_PUSH2}/clist/get',
            params={
                'pn': '1',
                'pz': '10',
                'po': '1',      # descending
                'np': '1',
                'fltt': '2',
                'invt': '2',
                'fid': 'f3',    # sort by change%
                'fs': 'm:90+t:3',  # concept boards
                'fields': 'f2,f3,f4,f8,f12,f14,f104,f105,f128,f136,f140,f141',
            },
            headers=_HEADERS,
            timeout=_TIMEOUT,
            proxies=_get_proxies(),
        )
        data = resp.json()

        events = []
        if data.get('data') and data['data'].get('diff'):
            for idx, item in enumerate(data['data']['diff']):
                name = str(item.get('f14', ''))
                change_pct = float(item.get('f3', 0))
                lead_stock = str(item.get('f128', ''))
                lead_code = str(item.get('f140', ''))
                up_count = int(item.get('f104', 0))
                down_count = int(item.get('f105', 0))
                amount = float(item.get('f136', 0)) if item.get('f136') else 0

                # Determine impact level
                if abs(change_pct) >= 3:
                    impact = 'high'
                elif abs(change_pct) >= 1.5:
                    impact = 'medium'
                else:
                    impact = 'low'

                # Build related stocks from leader + fetch board constituents
                related_stocks = []
                if lead_stock and lead_code:
                    related_stocks.append({
                        'code': lead_code,
                        'name': lead_stock,
                        'change': change_pct,
                    })

                # Try to get top 3 stocks from this concept board
                try:
                    board_code = str(item.get('f12', ''))
                    if board_code:
                        stocks_resp = requests.get(
                            f'{_PUSH2}/clist/get',
                            params={
                                'pn': '1',
                                'pz': '3',
                                'po': '1',
                                'np': '1',
                                'fltt': '2',
                                'fid': 'f3',
                                'fs': f'b:{board_code}+f:!50',
                                'fields': 'f3,f12,f14',
                            },
                            headers=_HEADERS,
                            timeout=5,
                            proxies=_get_proxies(),
                        )
                        stocks_data = stocks_resp.json()
                        if stocks_data.get('data') and stocks_data['data'].get('diff'):
                            related_stocks = []
                            for s in stocks_data['data']['diff'][:3]:
                                related_stocks.append({
                                    'code': str(s.get('f12', '')),
                                    'name': str(s.get('f14', '')),
                                    'change': float(s.get('f3', 0)),
                                })
                except Exception:
                    pass  # Keep leader stock only

                # Generate summary
                direction = '上涨' if change_pct > 0 else '下跌'
                summary = f'{name}板块今日{direction}{abs(change_pct):.2f}%，{up_count}只上涨/{down_count}只下跌。'
                if lead_stock:
                    summary += f'领涨股{lead_stock}。'
                if amount > 0:
                    summary += f'板块成交{amount / 1e8:.1f}亿元。'

                events.append({
                    'id': f'evt_{idx:03d}',
                    'title': f'{name}概念{direction}{abs(change_pct):.1f}%',
                    'summary': summary,
                    'keywords': [name, lead_stock, direction],
                    'relatedStocks': related_stocks,
                    'impact': impact,
                    'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
                    'source': '概念板块',
                    'type': 'market',
                })
        return events

    except Exception as e:
        logger.warning(f'eastmoney market events failed: {e}')
        return []


def _get_market_events_akshare():
    """Fallback: use akshare stock_board_concept_name_em for concept board data.
    Note: akshare calls eastmoney internally, so it NEEDS proxy on local Mac."""
    events = []
    try:
        import akshare as ak
        df = ak.stock_board_concept_name_em()
        if df is None or df.empty:
            return []

        # Sort by absolute change% descending, take top 10
        if '涨跌幅' in df.columns:
            df = df.sort_values('涨跌幅', key=abs, ascending=False).head(10)

        for idx, (_, row) in enumerate(df.iterrows()):
            name = str(row.get('板块名称', ''))
            change_pct = float(row.get('涨跌幅', 0) or 0)
            up_count = int(row.get('上涨家数', 0) or 0)
            down_count = int(row.get('下跌家数', 0) or 0)
            lead_stock = str(row.get('领涨股票', '') or '')
            lead_change = float(row.get('领涨涨跌幅', 0) or 0)
            amount = float(row.get('总成交额', 0) or 0)

            if abs(change_pct) >= 3:
                impact = 'high'
            elif abs(change_pct) >= 1.5:
                impact = 'medium'
            else:
                impact = 'low'

            related_stocks = []
            if lead_stock:
                related_stocks.append({
                    'name': lead_stock,
                    'code': '',
                    'change': lead_change,
                })

            direction = '上涨' if change_pct > 0 else '下跌'
            summary = f'{name}板块今日{direction}{abs(change_pct):.2f}%，{up_count}只上涨/{down_count}只下跌。'
            if lead_stock:
                summary += f'领涨股{lead_stock}。'
            if amount > 0:
                summary += f'板块成交{amount / 1e8:.1f}亿元。'

            events.append({
                'id': f'evt_{idx:03d}',
                'title': f'{name}概念{direction}{abs(change_pct):.1f}%',
                'summary': summary,
                'keywords': [name, lead_stock, direction],
                'relatedStocks': related_stocks,
                'impact': impact,
                'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
                'source': '概念板块',
                'type': 'market',
            })

        logger.warning(f'akshare concept board fallback: got {len(events)} events')
    except Exception as e:
        logger.warning(f'akshare concept board fallback failed: {e}\n{traceback.format_exc()}')

    return events


# ── Tushare concept board fallback ──

_CONCEPT_MAP_KEY = 'cn:tushare:concept_map'
_CONCEPT_MAP_TTL = 86400 * 7  # 7 days


def _get_redis():
    """Get Redis connection (works both inside and outside Flask context)."""
    try:
        from flask import current_app
        return current_app.redis
    except (RuntimeError, ImportError):
        pass
    # Fallback: direct connection (for background threads)
    try:
        import redis
        return redis.Redis(host=Config.REDIS_HOST, port=Config.REDIS_PORT,
                           db=Config.REDIS_DB, decode_responses=False)
    except Exception:
        return None


def _load_concept_map():
    """Load concept→stocks mapping from Redis cache."""
    try:
        r = _get_redis()
        if r:
            import json as _json
            val = r.get(_CONCEPT_MAP_KEY)
            if val:
                return _json.loads(val)
    except Exception:
        pass
    return None


def _save_concept_map(mapping):
    """Save concept→stocks mapping to Redis."""
    try:
        r = _get_redis()
        if r and mapping:
            import json as _json
            r.setex(_CONCEPT_MAP_KEY, _CONCEPT_MAP_TTL,
                    _json.dumps(mapping, ensure_ascii=False))
    except Exception:
        pass


def _build_concept_map_batch(pro, concept_ids):
    """Build concept→stocks mapping for a batch of concept IDs.
    Returns {concept_code: {name, stocks: [ts_code, ...]}}."""
    mapping = {}
    for cid, cname in concept_ids:
        try:
            detail = pro.concept_detail(id=cid)
            if detail is not None and not detail.empty:
                stocks = detail['ts_code'].tolist()
                mapping[cid] = {'name': cname, 'stocks': stocks}
        except Exception:
            pass
    return mapping


_concept_map_building = False


def _start_concept_map_build():
    """Build concept→stocks mapping in background thread."""
    global _concept_map_building
    if _concept_map_building:
        return
    _concept_map_building = True

    def _build():
        global _concept_map_building
        try:
            import tushare as _ts
            from config import Config
            _ts.set_token(Config.TUSHARE_TOKEN)
            _pro = _ts.pro_api()
            concepts_df = _pro.concept()
            if concepts_df is None or concepts_df.empty:
                return
            batch = [(row['code'], row['name'])
                     for _, row in concepts_df.head(200).iterrows()]
            mapping = _build_concept_map_batch(_pro, batch)
            if mapping:
                _save_concept_map(mapping)
                logger.warning(f'[bg] tushare concept map built: {len(mapping)} concepts')
        except Exception as e:
            logger.warning(f'[bg] concept map build failed: {e}\n{traceback.format_exc()}')
        finally:
            _concept_map_building = False

    import threading
    t = threading.Thread(target=_build, daemon=True)
    t.start()


def _get_market_events_tushare():
    """Fallback: use tushare daily() + cached concept mapping for concept boards.
    If no concept map cached, returns top movers as quick fallback and starts
    building the concept map in background for next request."""
    try:
        import tushare as ts
        from config import Config
        token = Config.TUSHARE_TOKEN
        if not token:
            return []
        ts.set_token(token)
        pro = ts.pro_api()

        # 1. Get today's daily data for all stocks (~1.5s)
        today = datetime.now().strftime('%Y%m%d')
        df_daily = pro.daily(trade_date=today)
        if df_daily is None or df_daily.empty:
            yesterday = (datetime.now() - timedelta(days=1)).strftime('%Y%m%d')
            df_daily = pro.daily(trade_date=yesterday)
            if df_daily is None or df_daily.empty:
                return []

        pct_map = dict(zip(df_daily['ts_code'], df_daily['pct_chg']))
        amount_map = dict(zip(df_daily['ts_code'], df_daily['amount']))

        # 2. Try cached concept mapping
        concept_map = _load_concept_map()
        if concept_map:
            events = _compute_concept_events(concept_map, pct_map)
            if events:
                logger.warning(f'tushare concept board (cached map): {len(events)} events')
                return events

        # 3. No concept map: return top movers as quick fallback
        #    and start building concept map in background
        _start_concept_map_build()
        events = _top_movers_as_events(df_daily)
        if events:
            logger.warning(f'tushare top movers fallback: {len(events)} events')
        return events

    except Exception as e:
        logger.warning(f'tushare fallback failed: {e}\n{traceback.format_exc()}')
        return []


def _compute_concept_events(concept_map, pct_map):
    """Compute concept board performance from cached mapping + daily data."""
    concept_scores = []
    for cid, info in concept_map.items():
        cname = info['name']
        stocks = info['stocks']
        changes = [pct_map[s] for s in stocks if s in pct_map]
        if len(changes) < 3:  # Skip concepts with too few active stocks
            continue
        avg_chg = sum(changes) / len(changes)
        up_count = sum(1 for c in changes if c > 0)
        down_count = sum(1 for c in changes if c < 0)
        top_stocks = sorted(
            [(s, pct_map[s]) for s in stocks if s in pct_map],
            key=lambda x: abs(x[1]), reverse=True
        )[:3]
        concept_scores.append({
            'name': cname,
            'avg_chg': avg_chg,
            'up': up_count,
            'down': down_count,
            'total': len(changes),
            'top_stocks': top_stocks,
        })

    concept_scores.sort(key=lambda x: abs(x['avg_chg']), reverse=True)
    events = []
    for idx, c in enumerate(concept_scores[:10]):
        change_pct = c['avg_chg']
        if abs(change_pct) >= 3:
            impact = 'high'
        elif abs(change_pct) >= 1.5:
            impact = 'medium'
        else:
            impact = 'low'

        related_stocks = []
        for ts_code, chg in c['top_stocks']:
            code = ts_code.split('.')[0]
            related_stocks.append({'code': code, 'name': ts_code, 'change': chg})

        direction = '上涨' if change_pct > 0 else '下跌'
        cname = c['name']
        # Avoid duplicate "概念" (some concept names already end with 概念)
        label = cname if cname.endswith('概念') else f'{cname}概念'
        summary = (f'{label}今日均{direction}{abs(change_pct):.2f}%，'
                   f'{c["up"]}只上涨/{c["down"]}只下跌(共{c["total"]}只)。')

        events.append({
            'id': f'evt_{idx:03d}',
            'title': f'{label}{direction}{abs(change_pct):.1f}%',
            'summary': summary,
            'keywords': [c['name'], direction],
            'relatedStocks': related_stocks,
            'impact': impact,
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'source': '概念板块',
            'type': 'market',
        })
    return events


def _top_movers_as_events(df_daily):
    """Quick fallback: return top movers as market events when no concept map available."""
    events = []
    # Top 5 gainers + top 5 losers
    top_up = df_daily.nlargest(5, 'pct_chg')
    top_down = df_daily.nsmallest(5, 'pct_chg')

    for idx, (_, row) in enumerate(top_up.iterrows()):
        ts_code = row['ts_code']
        code = ts_code.split('.')[0]
        pct = float(row['pct_chg'])
        amt = float(row.get('amount', 0))
        events.append({
            'id': f'evt_{idx:03d}',
            'title': f'{ts_code} 涨{pct:.1f}%',
            'summary': f'今日涨幅{pct:.2f}%，成交额{amt / 10000:.1f}万元。',
            'keywords': [ts_code, '涨幅居前'],
            'relatedStocks': [{'code': code, 'name': ts_code, 'change': pct}],
            'impact': 'high' if pct >= 10 else 'medium',
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'source': '涨幅排行',
            'type': 'market',
        })

    for idx2, (_, row) in enumerate(top_down.iterrows()):
        ts_code = row['ts_code']
        code = ts_code.split('.')[0]
        pct = float(row['pct_chg'])
        amt = float(row.get('amount', 0))
        events.append({
            'id': f'evt_{5 + idx2:03d}',
            'title': f'{ts_code} 跌{abs(pct):.1f}%',
            'summary': f'今日跌幅{abs(pct):.2f}%，成交额{amt / 10000:.1f}万元。',
            'keywords': [ts_code, '跌幅居前'],
            'relatedStocks': [{'code': code, 'name': ts_code, 'change': pct}],
            'impact': 'high' if abs(pct) >= 10 else 'medium',
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'source': '跌幅排行',
            'type': 'market',
        })

    return events


def _social_snapshot_key():
    return 'cn:hot-events:social-snapshot'


def _save_social_snapshot(events):
    """Save last successful social events to Redis as fallback snapshot."""
    try:
        from flask import current_app
        r = current_app.redis
        if r and events:
            import json as _json
            r.setex(_social_snapshot_key(), 7200, _json.dumps(events, ensure_ascii=False))
    except Exception:
        pass


def _load_social_snapshot():
    """Load social events snapshot from Redis when live fetch fails."""
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            import json as _json
            val = r.get(_social_snapshot_key())
            if val:
                items = _json.loads(val)
                # Mark as cached
                for item in items:
                    item['_stale'] = True
                return items
    except Exception:
        pass
    return []


def _get_social_events():
    """Get top social trending topics from weibo, baidu, toutiao (parallel).
    On failure/timeout, falls back to Redis snapshot."""
    fetchers = {
        'weibo': _fetch_weibo_top,
        'baidu': _fetch_baidu_top,
        'toutiao': _fetch_toutiao_top,
    }
    all_items = []

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fn): name for name, fn in fetchers.items()}
        try:
            for future in as_completed(futures, timeout=12):
                name = futures[future]
                try:
                    items = future.result()
                    all_items.extend(items)
                except Exception as e:
                    logger.warning(f'Social fetch {name} failed: {e}')
        except TimeoutError:
            logger.warning('Social events parallel fetch timeout')

    # Sort by engagement (hot value), take top 12
    all_items.sort(key=lambda x: x.get('engagement', 0), reverse=True)
    events = []
    seen_titles = set()
    for item in all_items:
        title = item['title']
        # Deduplicate similar titles across platforms
        if title in seen_titles:
            continue
        seen_titles.add(title)
        events.append(item)
        if len(events) >= 12:
            break

    # Save successful fetch as snapshot, or fall back to snapshot
    if events:
        _save_social_snapshot(events)
    else:
        snapshot = _load_social_snapshot()
        if snapshot:
            logger.warning(f'Social events using Redis snapshot ({len(snapshot)} items)')
            events = snapshot

    return events


def _fetch_weibo_top():
    """Fetch top 5 weibo hot search items as events."""
    items = []
    try:
        resp = requests.get(
            'https://weibo.com/ajax/side/hotSearch',
            headers={'User-Agent': _UA, 'Referer': 'https://weibo.com/'},
            timeout=8,
        )
        data = resp.json()
        realtime = data.get('data', {}).get('realtime', [])
        for idx, item in enumerate(realtime[:5]):
            word = item.get('word', '')
            label = item.get('label_name', '')
            num = int(item.get('num', 0))
            if not word:
                continue

            title_str = f'{word}' + (f' [{label}]' if label else '')
            impact = 'high' if num > 1000000 else ('medium' if num > 100000 else 'low')

            items.append({
                'id': f'social_wb_{idx}',
                'title': title_str,
                'summary': f'微博热搜第{idx+1}位，热度{num:,}',
                'keywords': [word, '微博'],
                'relatedStocks': _extract_related_stocks(word),
                'impact': impact,
                'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
                'source': '微博热搜',
                'type': 'social',
                'engagement': num,
                'url': f'https://s.weibo.com/weibo?q=%23{word}%23',
            })
    except Exception as e:
        logger.warning(f'Weibo top events failed: {e}')
    return items


def _fetch_baidu_top():
    """Fetch top 5 baidu hot search items as events."""
    import re as _re
    items = []
    try:
        resp = requests.get(
            'https://top.baidu.com/board?tab=realtime',
            headers={'User-Agent': _UA, 'Accept': 'text/html', 'Referer': 'https://top.baidu.com/'},
            timeout=8,
        )
        # Parse JSON data embedded in the page
        match = _re.search(r'<!--s-data:(.*?)-->', resp.text)
        if match:
            import json
            page_data = json.loads(match.group(1))
            cards = page_data.get('data', {}).get('cards', [])
            rank = 0
            for card in cards:
                for item in card.get('content', []):
                    word = item.get('word', '') or item.get('query', '')
                    hot_score = int(item.get('hotScore', 0))
                    desc = item.get('desc', '')
                    if not word:
                        continue
                    rank += 1
                    if rank > 5:
                        break

                    impact = 'high' if hot_score > 5000000 else ('medium' if hot_score > 1000000 else 'low')
                    summary = desc[:60] if desc else f'百度热搜第{rank}位，热度{hot_score:,}'

                    items.append({
                        'id': f'social_bd_{rank}',
                        'title': word,
                        'summary': summary,
                        'keywords': [word, '百度'],
                        'relatedStocks': _extract_related_stocks(word + ' ' + desc),
                        'impact': impact,
                        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
                        'source': '百度热搜',
                        'type': 'social',
                        'engagement': hot_score,
                        'url': f'https://www.baidu.com/s?wd={word}',
                    })
                if rank > 5:
                    break
    except Exception as e:
        logger.warning(f'Baidu top events failed: {e}')
    return items


def _fetch_toutiao_top():
    """Fetch top 5 toutiao hot topics as events."""
    items = []
    try:
        resp = requests.get(
            'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
            headers={'User-Agent': _UA, 'Referer': 'https://www.toutiao.com/'},
            timeout=8,
        )
        data = resp.json()
        for idx, item in enumerate(data.get('data', [])[:5]):
            title = item.get('Title', '')
            hot_value = int(item.get('HotValue', 0))
            url = item.get('Url', '')
            if not title:
                continue

            impact = 'high' if hot_value > 5000000 else ('medium' if hot_value > 1000000 else 'low')

            items.append({
                'id': f'social_tt_{idx}',
                'title': title,
                'summary': f'头条热榜第{idx+1}位，热度{hot_value:,}',
                'keywords': [title[:6], '头条'],
                'relatedStocks': _extract_related_stocks(title),
                'impact': impact,
                'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
                'source': '头条热榜',
                'type': 'social',
                'engagement': hot_value,
                'url': url,
            })
    except Exception as e:
        logger.warning(f'Toutiao top events failed: {e}')
    return items


def _fallback_events():
    """Minimal fallback when all sources fail."""
    return [{
        'id': 'evt_fallback',
        'title': '数据加载中',
        'summary': '正在获取最新热点数据，请稍后刷新。',
        'keywords': ['加载中'],
        'relatedStocks': [],
        'impact': 'low',
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'source': '系统',
        'type': 'system',
    }]
