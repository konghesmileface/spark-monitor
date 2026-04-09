"""Policy news persistent storage using MySQL (Aliyun RDS).
Stores all crawled policy/gov news for historical analysis.

Table: policy_news
  id          BIGINT AUTO_INCREMENT PK
  url_hash    VARCHAR(32) UNIQUE   -- MD5 of URL for dedup
  title       VARCHAR(500)
  url         VARCHAR(1000)
  news_date   DATE                 -- publish date from source
  source_key  VARCHAR(50)          -- e.g. 'people', 'caixin'
  source_name VARCHAR(100)         -- e.g. '人民日报', '财新'
  category    VARCHAR(50)          -- e.g. '央媒', '财经媒体'
  icon        VARCHAR(50)
  crawled_at  DATETIME DEFAULT NOW()
  INDEX idx_date (news_date), INDEX idx_source (source_key), INDEX idx_category (category)
"""

import hashlib
import logging
import re
import pymysql
from datetime import datetime, date, timedelta
from contextlib import contextmanager

logger = logging.getLogger('cn-intel.policy-store')


# ── Title sanitization (strip search engine artifacts) ─────────────────────
_TITLE_CLEAN_PATTERNS = [
    # cnstock: "要闻·两会1小时前", "各地·上海自贸试验区2小时前"
    (re.compile(r'[·•・][\u4e00-\u9fff]+\d+[小时天分钟]+前$'), ''),
    # Trailing relative time: "source_name3天前", "252 3小时前", "30721小时前"
    (re.compile(r'[\u4e00-\u9fff\w\.:/]{0,30}\d+[天小时分钟]+前$'), ''),
    # Inline "category·subcategory N(小时|分钟)前": "国际·石油27分钟前", "观察·《复杂经济学》1小时前"
    (re.compile(r'[\u4e00-\u9fff·•・《》]{2,12}\d+[小时分钟天]+前$'), ''),
    # cnstock trailing category: "...要闻", "...各地", "...国际", "...观察", "...政策"
    (re.compile(r'(要闻|各地|国际|观察|政策|产经)$'), ''),
    # jingji21 "焦点" prefix
    (re.compile(r'^焦点'), ''),
    # jingji21 trailing "21视频"
    (re.compile(r'21视频$'), ''),
    # "视频" or "视频丨" prefix
    (re.compile(r'^视频[丨|]?'), ''),
    # "T早报" prefix pipe separator
    (re.compile(r'^T早报[｜|]?'), 'T早报丨'),
    # Trailing "category N分钟前" / "刚刚"
    (re.compile(r'[\u4e00-\u9fff]{2,6}\s*\d*\s*[分钟小时天]+前$'), ''),
    (re.compile(r'[\u4e00-\u9fff]{2,6}\s*刚刚$'), ''),
    # Source + date suffix: "中国新闻网2026-03-18 10:56"
    (re.compile(r'[\u4e00-\u9fff]{2,10}\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}$'), ''),
    # Bilibili/video platform artifacts: "哔哩哔哩2023-11-10 10:01"
    (re.compile(r'哔哩哔哩\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}$'), ''),
    # Yicai/media trailing view-count + relative date + time:
    # "...3621昨天 21:15", "...1080昨天 20:19" (viewcount is 3-6 digits)
    (re.compile(r'\d{3,6}[昨今前]天\s*\d{1,2}:\d{2}$'), ''),
    # Trailing subcategory + view-count + relative date:
    # "...基金风云2325昨天 20:30", "...记者观察1434昨天 21:38"
    (re.compile(r'[\u4e00-\u9fff·•・|]{2,8}\d{3,6}[昨今前]天\s*\d{1,2}:\d{2}$'), ''),
    # Trailing "数字+月日 HH:MM": "...36213月29日 21:15"
    (re.compile(r'\d{3,6}\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}$'), ''),
    # Leading timestamp: "04:20" at start of title
    (re.compile(r'^\d{2}:\d{2}'), ''),
    # Editor/author lines: "责编：邱海峰  廖睿灵　邮箱：xxx"
    (re.compile(r'^责编[:：].*'), ''),
    (re.compile(r'^编辑[:：].*'), ''),
    # "公司" or "国际·股市" inline category+time: "日韩股市，开盘大跌国际·股市8分钟前"
    (re.compile(r'[\u4e00-\u9fff·•・]{2,10}\d+[分钟小时]+前$'), ''),
    # Trailing punctuation from over-stripping (includes middle dot variants)
    (re.compile(r'[，,｜|；;：:·•・\s]+$'), ''),
    # Leading punctuation
    (re.compile(r'^[，,｜|；;：:·•・\s]+'), ''),
]

# Titles that are clearly navigation/sidebar, not news
_NAV_TITLE_BLACKLIST = {
    '时政要闻', '统计新闻', '部门新闻', '地方新闻', '新闻发布',
    '更多', '首页', '政务公开', '会议活动', '数据发布', '数据解读',
    '图片报道', '图片新闻', '视频新闻',
    '中央人民政府门户网站', '国家发展改革委', '工业和信息化部',
    '财政部', '商务部', '中国人民银行', '海关总署', '国家税务总局',
}


def _clean_title(title: str) -> str:
    """Sanitize a title by stripping search engine artifacts."""
    if not title:
        return title
    # Strip whitespace variants
    title = re.sub(r'[\r\n\t]+', ' ', title).strip()
    # Reject navigation titles
    if title in _NAV_TITLE_BLACKLIST:
        return ''
    for pat, repl in _TITLE_CLEAN_PATTERNS:
        title = pat.sub(repl, title).strip()
    # Strip IMF/intl org date prefix: "March 28, 2026IMF ..." → "IMF ..."
    m = re.match(
        r'(?:January|February|March|April|May|June|July|August|September|'
        r'October|November|December)\s+\d{1,2},\s*\d{4}', title)
    if m:
        title = title[m.end():].strip()
    # Detect English/international titles (primarily ASCII/Latin) vs Chinese titles.
    # Chinese titles >80 chars almost always have body text leaking in from search
    # engines, but English news headlines routinely reach 100-150 chars.
    _cjk_count = sum(1 for c in title if '\u4e00' <= c <= '\u9fff')
    _is_intl = _cjk_count < len(title) * 0.2  # <20% CJK → international title
    _hard_cap = 200 if _is_intl else 80

    # Truncate titles with embedded body text
    if len(title) > _hard_cap:
        # Try cutting at first newline-like boundary
        nl = title.find('\n', 15)
        if nl > 0:
            title = title[:nl].strip()
    # Truncate search-result titles with concatenated snippets (Chinese only)
    if not _is_intl and len(title) > _hard_cap:
        # Cut at inline date: "2026年03月26日 22:46"
        m = re.search(r'\d{4}年\d{1,2}月\d{1,2}日\s*\d{2}:\d{2}', title)
        if m and m.start() > 10:
            title = title[:m.start()].rstrip('，,。. ')
        if len(title) > _hard_cap:
            m = re.search(
                r'(?:据新华社|记者\d{1,2}月|本报讯|本报记者|此次|日前,|近日,|为贯彻|残联与|《通知》强调)',
                title[15:])
            if m:
                title = title[:15 + m.start()].rstrip('，,。. ')
    # Hard cap
    if len(title) > _hard_cap:
        for sep in ('。', '；', '，', ',', ' '):
            idx = title.rfind(sep, 20, _hard_cap)
            if idx > 20:
                title = title[:idx]
                break
        else:
            title = title[:_hard_cap]
    # Reject navigation-only titles
    if len(title) < 5 or re.match(r'^\[.*\]$', title):
        return ''
    return title.strip()

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

_TABLE_CREATED = False

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS policy_news (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    url_hash    VARCHAR(32) NOT NULL,
    title       VARCHAR(500) NOT NULL,
    url         VARCHAR(1000) NOT NULL,
    news_date   DATE,
    source_key  VARCHAR(50) NOT NULL DEFAULT '',
    source_name VARCHAR(100) NOT NULL DEFAULT '',
    category    VARCHAR(50) NOT NULL DEFAULT '',
    icon        VARCHAR(50) NOT NULL DEFAULT '',
    summary     TEXT,
    crawled_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_url_hash (url_hash),
    KEY idx_date (news_date),
    KEY idx_source (source_key),
    KEY idx_category (category),
    KEY idx_crawled (crawled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


def _url_hash(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


@contextmanager
def _get_conn():
    from services.db_pool import get_connection
    conn = get_connection()
    try:
        yield conn
    finally:
        conn.close()


def _ensure_table():
    global _TABLE_CREATED
    if _TABLE_CREATED:
        return
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(_CREATE_TABLE_SQL)
                # Migration: add summary column if missing
                try:
                    cur.execute("ALTER TABLE policy_news ADD COLUMN summary TEXT AFTER icon")
                except Exception:
                    pass  # Column already exists
            conn.commit()
        _TABLE_CREATED = True
        logger.warning('[policy-store] Table policy_news ensured')
    except Exception as e:
        logger.warning(f'[policy-store] Table creation error: {e}')


def store_items(items: list) -> int:
    """Store a batch of policy news items. Returns count of new items added."""
    if not items:
        return 0
    _ensure_table()

    sql = """INSERT INTO policy_news
        (url_hash, title, url, news_date, source_key, source_name, category, icon, summary, crawled_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE summary = COALESCE(policy_news.summary, VALUES(summary))"""

    now = datetime.now()
    rows = []
    for item in items:
        url = item.get('url', '')
        if not url:
            continue
        title = _clean_title((item.get('title', '') or '')[:500])
        if not title:
            continue
        news_date = item.get('date', '') or None
        if news_date:
            try:
                # Validate date format and reject future dates
                d = datetime.strptime(news_date, '%Y-%m-%d').date()
                if d > datetime.now().date():
                    continue  # Skip future-dated articles
            except ValueError:
                news_date = None
        rows.append((
            _url_hash(url),
            title,
            url[:1000],
            news_date,
            (item.get('source_key', '') or '')[:50],
            (item.get('source', '') or '')[:100],
            (item.get('category', '') or '')[:50],
            (item.get('icon', '') or '')[:50],
            (item.get('summary', '') or '')[:2000] or None,
            now,
        ))

    if not rows:
        return 0

    new_count = 0
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                new_count = cur.executemany(sql, rows)
            conn.commit()
        if new_count > 0:
            logger.warning(f'[policy-store] Stored {new_count} new items (batch={len(rows)})')
    except Exception as e:
        logger.warning(f'[policy-store] Store error: {e}')
    return new_count


def get_items_by_date(date_str: str, limit: int = 200) -> list:
    """Get policy news items for a specific date."""
    _ensure_table()
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT * FROM policy_news WHERE news_date=%s ORDER BY crawled_at DESC LIMIT %s",
                    (date_str, limit))
                return _rows_to_items(cur.fetchall())
    except Exception as e:
        logger.warning(f'[policy-store] Query by date error: {e}')
        return []


def get_items_by_date_range(start_date: str, end_date: str,
                            category: str = '', source_key: str = '',
                            limit: int = 500) -> list:
    """Get policy news items within a date range, optionally filtered."""
    _ensure_table()
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                sql = "SELECT * FROM policy_news WHERE news_date BETWEEN %s AND %s"
                params = [start_date, end_date]
                if category:
                    sql += " AND category=%s"
                    params.append(category)
                if source_key:
                    sql += " AND source_key=%s"
                    params.append(source_key)
                sql += " ORDER BY news_date DESC, crawled_at DESC LIMIT %s"
                params.append(limit)
                cur.execute(sql, params)
                return _rows_to_items(cur.fetchall())
    except Exception as e:
        logger.warning(f'[policy-store] Query by range error: {e}')
        return []


def search_items(keyword: str, limit: int = 100) -> list:
    """Search stored policy items by keyword in title."""
    _ensure_table()
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT * FROM policy_news WHERE title LIKE %s ORDER BY crawled_at DESC LIMIT %s",
                    (f'%{keyword}%', limit))
                return _rows_to_items(cur.fetchall())
    except Exception as e:
        logger.warning(f'[policy-store] Search error: {e}')
        return []


def get_stats() -> dict:
    """Get storage statistics."""
    _ensure_table()
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute("SELECT COUNT(*) as total FROM policy_news")
                total = cur.fetchone()['total']

                today = date.today().isoformat()
                cur.execute("SELECT COUNT(*) as cnt FROM policy_news WHERE news_date=%s", (today,))
                today_count = cur.fetchone()['cnt']

                cur.execute("SELECT MIN(news_date) as earliest, MAX(news_date) as latest FROM policy_news")
                range_row = cur.fetchone()

                cur.execute(
                    "SELECT source_key, source_name, COUNT(*) as cnt "
                    "FROM policy_news GROUP BY source_key, source_name ORDER BY cnt DESC")
                sources = {r['source_key']: {'name': r['source_name'], 'count': r['cnt']}
                           for r in cur.fetchall()}

                cur.execute(
                    "SELECT category, COUNT(*) as cnt "
                    "FROM policy_news GROUP BY category ORDER BY cnt DESC")
                categories = {r['category']: r['cnt'] for r in cur.fetchall()}

                return {
                    'total': total,
                    'today_count': today_count,
                    'earliest_date': str(range_row['earliest']) if range_row['earliest'] else None,
                    'latest_date': str(range_row['latest']) if range_row['latest'] else None,
                    'sources': sources,
                    'categories': categories,
                }
    except Exception as e:
        logger.warning(f'[policy-store] Stats error: {e}')
        return {'total': 0}


def get_date_summary(days: int = 30) -> list:
    """Get daily article counts for the past N days."""
    _ensure_table()
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                start = (date.today() - timedelta(days=days)).isoformat()
                cur.execute(
                    "SELECT news_date, COUNT(*) as cnt "
                    "FROM policy_news WHERE news_date >= %s "
                    "GROUP BY news_date ORDER BY news_date DESC",
                    (start,))
                return [{'date': str(r['news_date']), 'count': r['cnt']} for r in cur.fetchall()]
    except Exception as e:
        logger.warning(f'[policy-store] Date summary error: {e}')
        return []


def search_related_policies(keywords: list, exclude_url: str = '', limit: int = 50) -> list:
    """Search for related policies across years using multiple keywords.
    Returns items sorted by date (newest first), grouped by year."""
    _ensure_table()
    if not keywords:
        return []
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                # Build OR conditions for each keyword
                conditions = []
                params = []
                for kw in keywords[:5]:  # max 5 keywords
                    if len(kw) >= 2:
                        conditions.append("title LIKE %s")
                        params.append(f'%{kw}%')
                if not conditions:
                    return []
                where = ' OR '.join(conditions)
                sql = f"SELECT * FROM policy_news WHERE ({where})"
                if exclude_url:
                    sql += " AND url != %s"
                    params.append(exclude_url)
                sql += " ORDER BY news_date DESC LIMIT %s"
                params.append(limit)
                cur.execute(sql, params)
                return _rows_to_items(cur.fetchall())
    except Exception as e:
        logger.warning(f'[policy-store] Related search error: {e}')
        return []


def search_items_full_history(keywords: list, limit: int = 200) -> list:
    """Search all stored policy items (no date limit) by multiple keywords.
    Returns items sorted by date descending."""
    _ensure_table()
    if not keywords:
        return []
    try:
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                conditions = []
                params = []
                for kw in keywords[:8]:
                    if len(kw) >= 2:
                        conditions.append("title LIKE %s")
                        params.append(f'%{kw}%')
                if not conditions:
                    return []
                where = ' OR '.join(conditions)
                sql = f"SELECT * FROM policy_news WHERE ({where}) ORDER BY news_date DESC LIMIT %s"
                params.append(limit)
                cur.execute(sql, params)
                return _rows_to_items(cur.fetchall())
    except Exception as e:
        logger.warning(f'[policy-store] Full history search error: {e}')
        return []


def _rows_to_items(rows: list) -> list:
    """Convert DB rows to standardized item dicts."""
    items = []
    for r in rows:
        title = _clean_title(r.get('title', ''))
        if not title:
            continue
        item = {
            'title': title,
            'url': r.get('url', ''),
            'date': str(r['news_date']) if r.get('news_date') else '',
            'source': r.get('source_name', ''),
            'source_key': r.get('source_key', ''),
            'category': r.get('category', ''),
            'icon': r.get('icon', ''),
            'crawled_at': r['crawled_at'].isoformat() if r.get('crawled_at') else '',
        }
        if r.get('summary'):
            item['summary'] = r['summary']
        items.append(item)
    return items
