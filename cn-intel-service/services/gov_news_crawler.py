"""Government, official media & financial media news crawler.
Fetches from 56 sources across 17 categories: central media, fiscal/monetary,
financial regulation, State Council, statistics, theory/politics, overseas,
financial media, think tanks, trade/foreign affairs, leaders, discipline,
audit, ministries, state-owned enterprises, intl central banks, intl orgs."""

import logging
import re
import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date, timedelta
from urllib.parse import urljoin, quote as urlquote

logger = logging.getLogger('cn-intel.gov')

import os
import xml.etree.ElementTree as ET

_TIMEOUT = 10
_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
_NO_PROXY = {'http': None, 'https': None}
# Proxy for international sites (GFW blocked)
_PROXY_URL = os.environ.get('HTTP_PROXY', os.environ.get('HTTPS_PROXY', ''))
_INTL_PROXY = {'http': _PROXY_URL, 'https': _PROXY_URL} if _PROXY_URL else None

# ── Source registry ──────────────────────────────────────────────────────────
GOV_SOURCES = {
    # ── 央媒 ──
    'people': {
        'name': '人民日报',
        'category': '央媒',
        'url': 'http://politics.people.com.cn/GB/1024/',
        'icon': 'bi-flag-fill',
    },
    'xinhua': {
        'name': '新华网',
        'category': '央媒',
        'url': 'http://www.news.cn/politics/',
        'icon': 'bi-flag-fill',
    },
    'cctv': {
        'name': '央视新闻',
        'category': '央媒',
        'url': 'https://news.cctv.com/china/',
        'icon': 'bi-tv',
    },
    'ce': {
        'name': '经济日报',
        'category': '央媒',
        'url': 'http://www.ce.cn/xwzx/gnsz/gdxw/',
        'icon': 'bi-newspaper',
    },
    # ── 财政/货币 ──
    'pbc': {
        'name': '中国人民银行',
        'category': '财政货币',
        'url': 'http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html',
        'icon': 'bi-bank',
    },
    'mof': {
        'name': '财政部',
        'category': '财政货币',
        'url': 'http://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/',
        'icon': 'bi-cash-coin',
    },
    'ndrc': {
        'name': '发改委',
        'category': '财政货币',
        'url': 'https://www.ndrc.gov.cn/xwdt/xwfb/',
        'icon': 'bi-building',
    },
    # ── 金融监管 ──
    'csrc': {
        'name': '证监会',
        'category': '金融监管',
        'url': 'http://www.csrc.gov.cn/csrc/c100028/',
        'icon': 'bi-shield-check',
    },
    'nfra': {
        'name': '金监总局',
        'category': '金融监管',
        'url': 'https://www.nfra.gov.cn/cn/view/pages/index/index.html',
        'icon': 'bi-shield-lock',
    },
    'sse': {
        'name': '上交所',
        'category': '金融监管',
        'url': 'http://www.sse.com.cn/aboutus/mediacenter/hotandd/',
        'icon': 'bi-graph-up-arrow',
    },
    'szse': {
        'name': '深交所',
        'category': '金融监管',
        'url': 'http://www.szse.cn/aboutus/trends/news/',
        'icon': 'bi-graph-down-arrow',
    },
    'bse': {
        'name': '北交所',
        'category': '金融监管',
        'url': 'https://www.bse.cn/important_news.html',
        'icon': 'bi-graph-up',
    },
    # ── 国务院 ──
    'gov': {
        'name': '国务院政策',
        'category': '国务院',
        'url': 'https://www.gov.cn/pushinfo/v150203/',
        'icon': 'bi-stars',
    },
    'gov_yaowen': {
        'name': '国务院要闻',
        'category': '国务院',
        'url': 'https://www.gov.cn/yaowen/liebiao/',
        'icon': 'bi-megaphone-fill',
    },
    # ── 统计 ──
    'stats': {
        'name': '国家统计局',
        'category': '统计',
        'url': 'https://www.stats.gov.cn/sj/zxfb/',
        'icon': 'bi-bar-chart-line',
    },
    'customs': {
        'name': '海关总署',
        'category': '统计',
        'url': 'http://www.customs.gov.cn/customs/302249/302274/302277/',
        'icon': 'bi-box-seam',
    },
    # ── 理论/政治局 ──
    'qiushi': {
        'name': '求是',
        'category': '理论',
        'url': 'http://www.qstheory.cn/',
        'icon': 'bi-journal-text',
    },
    'cpc': {
        'name': '反腐频道',
        'category': '纪检监察',
        'url': 'http://fanfu.people.com.cn/',
        'icon': 'bi-megaphone',
    },
    # ── 海外 ──
    'people_overseas': {
        'name': '人民日报海外版',
        'category': '海外',
        'url': 'http://paper.people.com.cn/rmrbhwb/',
        'icon': 'bi-globe2',
    },
    # ── 财经媒体 ──
    'caixin': {
        'name': '财新',
        'category': '财经媒体',
        'url': 'https://www.caixin.com/',
        'icon': 'bi-currency-yuan',
    },
    'yicai': {
        'name': '第一财经',
        'category': '财经媒体',
        'url': 'https://www.yicai.com/',
        'icon': 'bi-graph-up',
    },
    'stcn': {
        'name': '证券时报',
        'category': '财经媒体',
        'url': 'https://www.stcn.com/',
        'icon': 'bi-newspaper',
    },
    'cs': {
        'name': '中国证券报',
        'category': '财经媒体',
        'url': 'https://www.cs.com.cn/',
        'icon': 'bi-file-earmark-text',
    },
    'cnstock': {
        'name': '上海证券报',
        'category': '财经媒体',
        'url': 'https://news.cnstock.com/',
        'icon': 'bi-file-text',
    },
    'jingji21': {
        'name': '21世纪经济',
        'category': '财经媒体',
        'url': 'https://www.21jingji.com/',
        'icon': 'bi-journal-richtext',
    },
    'nbd': {
        'name': '每日经济新闻',
        'category': '财经媒体',
        'url': 'https://www.nbd.com.cn/',
        'icon': 'bi-newspaper',
    },
    'jiemian': {
        'name': '界面新闻',
        'category': '财经媒体',
        'url': 'https://www.jiemian.com/',
        'icon': 'bi-layout-text-window',
    },
    'jjckb': {
        'name': '经济参考报',
        'category': '财经媒体',
        'url': 'http://www.jjckb.cn/',
        'icon': 'bi-journal-text',
    },
    'eeo': {
        'name': '经济观察报',
        'category': '财经媒体',
        'url': 'https://www.eeo.com.cn/',
        'icon': 'bi-binoculars',
    },
    'thepaper': {
        'name': '澎湃新闻',
        'category': '财经媒体',
        'url': 'https://www.thepaper.cn/',
        'icon': 'bi-tsunami',
    },
    # ── 智库 ──
    'cssn': {
        'name': '中国社科院',
        'category': '智库',
        'url': 'http://www.cssn.cn/',
        'icon': 'bi-mortarboard',
    },
    'ciis': {
        'name': '国际问题研究院',
        'category': '智库',
        'url': 'https://www.ciis.org.cn/',
        'icon': 'bi-globe',
    },
    # ── 外贸外交 ──
    'mofcom': {
        'name': '商务部',
        'category': '外贸外交',
        'url': 'http://www.mofcom.gov.cn/',
        'icon': 'bi-shop',
    },
    'mfa': {
        'name': '外交部',
        'category': '外贸外交',
        'url': 'https://www.mfa.gov.cn/web/wjdt_674879/wjbxw_674885/',
        'icon': 'bi-globe2',
    },
    'safe': {
        'name': '国家外汇局',
        'category': '外贸外交',
        'url': 'https://www.safe.gov.cn/',
        'icon': 'bi-currency-exchange',
    },
    # ── 领导活动 ──
    'leaders': {
        'name': '高层动态',
        'category': '领导活动',
        'url': 'http://politics.people.com.cn/GB/1024/index1.html',
        'icon': 'bi-person-badge',
    },
    'xinhua_leaders': {
        'name': '新华网领导活动',
        'category': '领导活动',
        'url': 'http://www.news.cn/politics/leaders/',
        'icon': 'bi-person-badge-fill',
    },
    'gov_premier': {
        'name': '国务院总理',
        'category': '领导活动',
        'url': 'https://www.gov.cn/premier/',
        'icon': 'bi-stars',
    },
    'pbc_governor': {
        'name': '央行行长',
        'category': '领导活动',
        'url': 'http://www.pbc.gov.cn/hangzhang/',
        'icon': 'bi-bank',
    },
    'mof_minister': {
        'name': '财政部部长',
        'category': '领导活动',
        'url': 'http://www.mof.gov.cn/zhengwuxinxi/buzhanghuodong/',
        'icon': 'bi-cash-coin',
    },
    'ndrc_chairman': {
        'name': '发改委主任',
        'category': '领导活动',
        'url': 'https://www.ndrc.gov.cn/xxgk/ldxx/',
        'icon': 'bi-building',
    },
    'csrc_chairman': {
        'name': '证监会主席',
        'category': '领导活动',
        'url': 'http://www.csrc.gov.cn/zjhxwfb/xwdd/zjhlddt/',
        'icon': 'bi-shield-check',
    },
    'nfra_chairman': {
        'name': '金监总局局长',
        'category': '领导活动',
        'url': 'https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemPId=923',
        'icon': 'bi-shield-lock',
    },
    'mofcom_minister': {
        'name': '商务部部长',
        'category': '领导活动',
        'url': 'http://www.mofcom.gov.cn/article/i/jyjl/',
        'icon': 'bi-shop',
    },
    'mfa_spokesman': {
        'name': '外交部发言人',
        'category': '领导活动',
        'url': 'https://www.mfa.gov.cn/web/fyrbt_673021/',
        'icon': 'bi-globe2',
    },
    'safe_director': {
        'name': '外汇局局长',
        'category': '领导活动',
        'url': 'https://www.safe.gov.cn/safe/rdjj/index.html',
        'icon': 'bi-currency-exchange',
    },
    'miit_minister': {
        'name': '工信部部长',
        'category': '领导活动',
        'url': 'https://www.miit.gov.cn/gzcy/bzhdxwfbh/ld/',
        'icon': 'bi-cpu-fill',
    },
    'mohrss_minister': {
        'name': '人社部部长',
        'category': '领导活动',
        'url': 'http://www.mohrss.gov.cn/SYrlzyhshbzb/dongtaixinwen/buneiyaowen/',
        'icon': 'bi-people',
    },
    'mohurd_minister': {
        'name': '住建部部长',
        'category': '领导活动',
        'url': 'https://www.mohurd.gov.cn/xinwen/lingdaohuodong/',
        'icon': 'bi-house-door',
    },
    'mot_minister': {
        'name': '交通部部长',
        'category': '领导活动',
        'url': 'https://www.mot.gov.cn/jiaotongyaowen/202109/t20210901_3617449.html',
        'icon': 'bi-truck',
    },
    'moa_minister': {
        'name': '农业部部长',
        'category': '领导活动',
        'url': 'http://www.moa.gov.cn/xw/bmdt/',
        'icon': 'bi-flower1',
    },
    'most_minister': {
        'name': '科技部部长',
        'category': '领导活动',
        'url': 'https://www.most.gov.cn/kjbgz/',
        'icon': 'bi-cpu',
    },
    'mee_minister': {
        'name': '环境部部长',
        'category': '领导活动',
        'url': 'https://www.mee.gov.cn/home/bzhdt/',
        'icon': 'bi-tree',
    },
    'nhc_director': {
        'name': '卫健委主任',
        'category': '领导活动',
        'url': 'http://www.nhc.gov.cn/wjw/ldxx/list.shtml',
        'icon': 'bi-heart-pulse',
    },
    'mem_minister': {
        'name': '应急部部长',
        'category': '领导活动',
        'url': 'https://www.mem.gov.cn/gk/ldxx/',
        'icon': 'bi-shield-exclamation',
    },
    'sasac_director': {
        'name': '国资委主任',
        'category': '领导活动',
        'url': 'http://www.sasac.gov.cn/n2588025/n2588119/index.html',
        'icon': 'bi-building-gear',
    },
    # ── 纪检监察 ──
    'ccdi_inspect': {
        'name': '审查调查',
        'category': '纪检监察',
        'url': 'https://www.thepaper.cn/searchResult?keyword=审查调查',
        'icon': 'bi-search',
    },
    # ── 审计 ──
    'audit': {
        'name': '审计署',
        'category': '审计',
        'url': 'http://www.audit.gov.cn/n4/n19/index.html',
        'icon': 'bi-clipboard-check',
    },
    # ── 部委动态 ──
    'miit': {
        'name': '工信部',
        'category': '部委动态',
        'url': 'https://www.miit.gov.cn/xwdt/gxdt/',
        'icon': 'bi-cpu-fill',
    },
    'mohurd': {
        'name': '住建部',
        'category': '部委动态',
        'url': 'https://www.mohurd.gov.cn/xinwen/jsyw/',
        'icon': 'bi-house-door',
    },
    'mohrss': {
        'name': '人社部',
        'category': '部委动态',
        'url': 'http://www.mohrss.gov.cn/xxgk2020/fdzdgknr/',
        'icon': 'bi-people',
    },
    'nhc': {
        'name': '卫健委',
        'category': '部委动态',
        'url': 'http://www.nhc.gov.cn/xcs/yqtb/list_gzbd.shtml',
        'icon': 'bi-heart-pulse',
    },
    'mot': {
        'name': '交通运输部',
        'category': '部委动态',
        'url': 'https://www.mot.gov.cn/',
        'icon': 'bi-truck',
    },
    'moa': {
        'name': '农业农村部',
        'category': '部委动态',
        'url': 'http://www.moa.gov.cn/',
        'icon': 'bi-flower1',
    },
    'most': {
        'name': '科技部',
        'category': '部委动态',
        'url': 'https://www.most.gov.cn/',
        'icon': 'bi-cpu',
    },
    'mee': {
        'name': '生态环境部',
        'category': '部委动态',
        'url': 'https://www.mee.gov.cn/',
        'icon': 'bi-tree',
    },
    'mwr': {
        'name': '水利部',
        'category': '部委动态',
        'url': 'http://www.mwr.gov.cn/',
        'icon': 'bi-droplet',
    },
    'mem': {
        'name': '应急管理部',
        'category': '部委动态',
        'url': 'https://www.mem.gov.cn/',
        'icon': 'bi-shield-exclamation',
    },
    'chinatax': {
        'name': '税务总局',
        'category': '部委动态',
        'url': 'http://www.chinatax.gov.cn/',
        'icon': 'bi-receipt',
    },
    'moe': {
        'name': '教育部',
        'category': '部委动态',
        'url': 'http://www.moe.gov.cn/',
        'icon': 'bi-mortarboard-fill',
    },
    'mct': {
        'name': '文旅部',
        'category': '部委动态',
        'url': 'https://www.mct.gov.cn/',
        'icon': 'bi-palette',
    },
    'mnr': {
        'name': '自然资源部',
        'category': '部委动态',
        'url': 'https://www.mnr.gov.cn/',
        'icon': 'bi-geo-alt',
    },
    'samr': {
        'name': '市场监管总局',
        'category': '部委动态',
        'url': 'https://www.samr.gov.cn/',
        'icon': 'bi-shop-window',
    },
    'mva': {
        'name': '退役军人部',
        'category': '部委动态',
        'url': 'https://www.mva.gov.cn/',
        'icon': 'bi-person-badge-fill',
    },
    'nea': {
        'name': '国家能源局',
        'category': '部委动态',
        'url': 'http://www.nea.gov.cn/xwzx/nyyw.htm',
        'icon': 'bi-lightning-charge',
    },
    'moj': {
        'name': '司法部',
        'category': '部委动态',
        'url': 'http://www.moj.gov.cn/',
        'icon': 'bi-balance-scale',
    },
    'mca': {
        'name': '民政部',
        'category': '部委动态',
        'url': 'https://www.mca.gov.cn/',
        'icon': 'bi-people-fill',
    },
    'nhsa': {
        'name': '国家医保局',
        'category': '部委动态',
        'url': 'http://www.nhsa.gov.cn/',
        'icon': 'bi-hospital',
    },
    # ── 国资央企 ──
    'sasac': {
        'name': '国资委',
        'category': '国资央企',
        'url': 'http://www.sasac.gov.cn/',
        'icon': 'bi-building-gear',
    },
    # ── 国际央行 ──
    'fed': {
        'name': '美联储',
        'category': '国际央行',
        'url': 'https://www.federalreserve.gov/newsevents.htm',
        'icon': 'bi-bank2',
    },
    'ecb': {
        'name': '欧央行',
        'category': '国际央行',
        'url': 'https://www.ecb.europa.eu/press/pr/html/index.en.html',
        'icon': 'bi-bank2',
    },
    'boj': {
        'name': '日本央行',
        'category': '国际央行',
        'url': 'https://www.boj.or.jp/en/announcements/index.htm',
        'icon': 'bi-bank2',
    },
    'boe': {
        'name': '英国央行',
        'category': '国际央行',
        'url': 'https://www.bankofengland.co.uk/news',
        'icon': 'bi-bank2',
    },
    # ── 国际机构 ──
    'imf': {
        'name': 'IMF',
        'category': '国际机构',
        'url': 'https://www.imf.org/en/News',
        'icon': 'bi-globe-americas',
    },
    'bis': {
        'name': 'BIS',
        'category': '国际机构',
        'url': 'https://www.bis.org/list/press_rel/index.htm',
        'icon': 'bi-globe-americas',
    },
    # ── 国际媒体 ──
    'reuters': {
        'name': 'Reuters',
        'category': '国际媒体',
        'url': 'https://www.reuters.com/business/',
        'icon': 'bi-broadcast',
    },
    'cnbc': {
        'name': 'CNBC',
        'category': '国际媒体',
        'url': 'https://www.cnbc.com/',
        'icon': 'bi-tv-fill',
    },
    'nikkei': {
        'name': '日经新闻',
        'category': '国际媒体',
        'url': 'https://asia.nikkei.com/',
        'icon': 'bi-newspaper',
    },
    'bloomberg': {
        'name': 'Bloomberg',
        'category': '国际媒体',
        'url': 'https://www.bloomberg.com/markets/',
        'icon': 'bi-bar-chart-line-fill',
    },
}

GOV_CATEGORIES = ['领导活动', '央媒', '纪检监察', '审计', '财政货币', '金融监管',
                  '国务院', '统计', '部委动态', '国资央企', '理论', '海外',
                  '外贸外交', '财经媒体', '智库', '国际央行', '国际机构', '国际媒体']


# ── HTTP helper ──────────────────────────────────────────────────────────────

def _safe_get(url, timeout=_TIMEOUT, encoding=None, retries=2):
    """Fetch URL with auto-encoding detection and retry with backoff."""
    import time as _time
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = requests.get(
                url,
                headers={'User-Agent': _UA},
                timeout=timeout,
                proxies=_NO_PROXY,
                verify=False,
            )
            resp.raise_for_status()
            if encoding:
                resp.encoding = encoding
            elif resp.apparent_encoding:
                resp.encoding = resp.apparent_encoding
            elif '.gov.cn' in url or '.com.cn' in url:
                resp.encoding = 'utf-8'
            return resp
        except Exception as e:
            last_err = e
            if attempt < retries:
                _time.sleep(1 * (attempt + 1))  # 1s, 2s backoff
    logger.warning(f'GET failed {url} ({retries + 1} attempts): {last_err}')
    return None


def _safe_get_intl(url, timeout=15, encoding=None, retries=2):
    """Fetch URL for international sites (through proxy, then direct fallback)."""
    import time as _time
    last_err = None
    # Try with proxy
    for attempt in range(retries + 1):
        try:
            resp = requests.get(
                url,
                headers={'User-Agent': _UA},
                timeout=timeout,
                proxies=_INTL_PROXY if _INTL_PROXY else _NO_PROXY,
                verify=False,
            )
            resp.raise_for_status()
            if encoding:
                resp.encoding = encoding
            elif resp.apparent_encoding:
                resp.encoding = resp.apparent_encoding
            return resp
        except Exception as e:
            last_err = e
            if attempt < retries:
                _time.sleep(1 * (attempt + 1))
    # Fallback: try direct — Fed/ECB/BOJ/BOE/IMF/BIS are not GFW-blocked
    if _INTL_PROXY:
        try:
            resp = requests.get(
                url,
                headers={'User-Agent': _UA},
                timeout=timeout,
                proxies=_NO_PROXY,
                verify=False,
            )
            resp.raise_for_status()
            if encoding:
                resp.encoding = encoding
            elif resp.apparent_encoding:
                resp.encoding = resp.apparent_encoding
            logger.warning(f'GET intl OK via direct fallback: {url}')
            return resp
        except Exception as e2:
            last_err = e2
    logger.warning(f'GET intl failed {url} (proxy+direct): {last_err}')
    return None


_MONTH_MAP = {'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
              'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'}


def _parse_rss_date(text):
    """Parse RFC 2822 or ISO date from RSS pubDate/updated field."""
    if not text:
        return ''
    # RFC 2822: "Mon, 11 Mar 2026 14:00:00 GMT"
    m = re.search(r'(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})', text)
    if m:
        return f'{m.group(3)}-{_MONTH_MAP.get(m.group(2), "01")}-{int(m.group(1)):02d}'
    # ISO: "2026-03-11T..."
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})', text)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
    return ''


def _parse_rss_items(xml_text, source_key, max_items=15):
    """Parse RSS 2.0 or Atom XML and return news items."""
    items = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        logger.warning(f'RSS parse error for {source_key}: {e}')
        return []

    # RSS 2.0: <channel><item><title><link><pubDate><description>
    for item_el in root.iter('item'):
        title_el = item_el.find('title')
        link_el = item_el.find('link')
        pubdate_el = item_el.find('pubDate')
        desc_el = item_el.find('description')
        if title_el is None or not (title_el.text or '').strip():
            continue
        title = title_el.text.strip()
        link = (link_el.text or '').strip() if link_el is not None else ''
        if not link:
            continue
        d = _parse_rss_date(pubdate_el.text if pubdate_el is not None else '')
        raw_desc = (desc_el.text or '').strip() if desc_el is not None else ''
        # Strip HTML tags from description (Google News RSS returns HTML links)
        if raw_desc and '<' in raw_desc:
            import re
            summary = re.sub(r'<[^>]+>', '', raw_desc).strip()
        else:
            summary = raw_desc
        # Skip useless descriptions (too short or just a link)
        if len(summary) < 30:
            summary = ''
        items.append(_make_item(title, link, d, source_key, summary=summary))
        if len(items) >= max_items:
            break
    if items:
        return items

    # RSS 1.0 (RDF): namespace http://purl.org/rss/1.0/
    _RSS1 = '{http://purl.org/rss/1.0/}'
    for item_el in root.iter(f'{_RSS1}item'):
        title_el = item_el.find(f'{_RSS1}title')
        link_el = item_el.find(f'{_RSS1}link')
        date_el = item_el.find('{http://purl.org/dc/elements/1.1/}date')
        if title_el is None or not (title_el.text or '').strip():
            continue
        title = title_el.text.strip()
        link = (link_el.text or '').strip() if link_el is not None else ''
        if not link:
            continue
        d = _parse_rss_date(date_el.text if date_el is not None else '')
        items.append(_make_item(title, link, d, source_key))
        if len(items) >= max_items:
            break
    if items:
        return items

    # Atom: <entry><title><link href="..."><updated>
    for entry in root.iter('{http://www.w3.org/2005/Atom}entry'):
        title_el = entry.find('{http://www.w3.org/2005/Atom}title')
        link_el = entry.find('{http://www.w3.org/2005/Atom}link')
        updated_el = entry.find('{http://www.w3.org/2005/Atom}updated')
        if title_el is None or not (title_el.text or '').strip():
            continue
        title = title_el.text.strip()
        link = link_el.get('href', '') if link_el is not None else ''
        if not link:
            continue
        d = _parse_rss_date(updated_el.text if updated_el is not None else '')
        items.append(_make_item(title, link, d, source_key))
        if len(items) >= max_items:
            break

    return items


def _extract_date(text):
    """Try to extract a date string from text."""
    if not text:
        return ''
    text = text.strip()
    # 2026-03-11 or 2026/03/11
    m = re.search(r'(\d{4}[-/]\d{1,2}[-/]\d{1,2})', text)
    if m:
        return m.group(1).replace('/', '-')
    # 03-11 or 03/11
    m = re.search(r'(\d{1,2}[-/]\d{1,2})', text)
    if m:
        return f'{date.today().year}-{m.group(1).replace("/", "-")}'
    return ''


def _validate_date(date_str):
    """Validate a YYYY-MM-DD date string: must be real calendar date,
    not in the future, and not older than 365 days. Returns '' if invalid."""
    if not date_str:
        return ''
    try:
        d = datetime.strptime(date_str, '%Y-%m-%d').date()
    except (ValueError, TypeError):
        return ''
    today = date.today()
    if d > today:
        return ''
    if (today - d).days > 365:
        return ''
    return date_str


def _abs_url(base, href):
    """Resolve relative URL."""
    if not href:
        return ''
    if href.startswith('http'):
        return href
    return urljoin(base, href)


def _make_item(title, url, date_str, source_key, summary=''):
    """Create a standardized news item."""
    src = GOV_SOURCES.get(source_key, {})
    item = {
        'title': title.strip(),
        'url': url,
        'date': _validate_date(date_str),
        'source': src.get('name', source_key),
        'source_key': source_key,
        'category': src.get('category', ''),
        'icon': src.get('icon', 'bi-flag-fill'),
    }
    if summary:
        item['summary'] = summary[:2000]
    return item


# ── Per-source fetchers ─────────────────────────────────────────────────────

def _fetch_people():
    """人民日报 政治频道 + 经济频道 — a[href*=/n1/]"""
    urls = [
        ('http://politics.people.com.cn/GB/1024/', 'http://politics.people.com.cn'),
        ('http://finance.people.com.cn/', 'http://finance.people.com.cn'),
    ]
    items = []
    seen = set()
    for page_url, base in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href*="/n1/"]'):
            title = a.get_text(strip=True)
            if len(title) < 6 or title in seen:
                continue
            href = a.get('href', '')
            d = ''
            m = re.search(r'/(\d{4})/(\d{2})(\d{2})/', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
            seen.add(title)
            items.append(_make_item(title, _abs_url(base, href), d, 'people'))
    if not items:
        return _fetch_search_news('人民日报', 'people')
    return items[:35]


def _fetch_xinhua():
    """新华网 政治 + 财经"""
    urls = [
        'http://www.news.cn/politics/',
        'http://www.news.cn/fortune/',
    ]
    items = []
    seen = set()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href]'):
            href = a.get('href', '')
            title = a.get_text(strip=True)
            if len(title) < 6 or title in seen:
                continue
            if '/politics/' not in href and '/fortune/' not in href and '/20' not in href:
                continue
            if href.endswith('.htm') or href.endswith('.html') or href.endswith('.shtml'):
                d = ''
                m = re.search(r'/(\d{4})(\d{2})(\d{2})/', href) or re.search(r'/(\d{4})-(\d{2})/(\d{2})/', href)
                if m:
                    d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
                seen.add(title)
                items.append(_make_item(title, _abs_url('http://www.news.cn', href), d, 'xinhua'))
    if not items:
        return _fetch_search_news('新华网', 'xinhua')
    return items[:30]


def _fetch_cctv():
    """央视新闻 国内 + 财经"""
    urls = [
        'https://news.cctv.com/china/',
        'https://news.cctv.com/finance/',
    ]
    items = []
    seen = set()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href]'):
            href = a.get('href', '')
            title = a.get_text(strip=True)
            if len(title) < 6 or not href or title in seen:
                continue
            if not (href.endswith('.shtml') or href.endswith('.html')):
                continue
            # Accept /china/, /finance/, or date-based paths
            if '/china/' not in href and '/finance/' not in href and '/20' not in href:
                continue
            d = ''
            m = re.search(r'/(\d{4})/(\d{2})/(\d{2})/', href) or re.search(r'/(\d{4})(\d{2})(\d{2})/', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
            seen.add(title)
            items.append(_make_item(title, href, d, 'cctv'))
    if not items:
        return _fetch_search_news('央视新闻', 'cctv')
    return items[:30]


def _fetch_ce():
    """经济日报 国内时政高端访谈"""
    resp = _safe_get('http://www.ce.cn/xwzx/gnsz/gdxw/')
    if not resp:
        return _fetch_search_news('经济日报', 'ce')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    for li in soup.select('li'):
        a = li.find('a')
        if not a:
            continue
        title = a.get_text(strip=True)
        if len(title) < 6:
            continue
        href = a.get('href', '')
        if not href or href.startswith('http://district'):
            continue
        # Extract date from URL pattern /202603/t20260311_
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        span = li.find('span')
        if not d and span:
            d = _extract_date(span.get_text())
        items.append(_make_item(title, _abs_url('http://www.ce.cn/xwzx/gnsz/gdxw/', href), d, 'ce'))
    return items[:20]


def _fetch_pbc():
    """央行 新闻发布 + 货币政策 + 金融统计 — font.newslist_style > a[title] + span.hui12"""
    urls = [
        'http://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html',
        'http://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125431/125475/index.html',
        'http://www.pbc.gov.cn/diaochatongjisi/116219/116319/index.html',
    ]
    items = []
    seen = set()
    for page_url in urls:
        resp = _safe_get(page_url, encoding='utf-8')
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for font in soup.select('font.newslist_style'):
            a = font.find('a', title=True)
            if not a:
                continue
            title = a.get('title', '').strip()
            if len(title) < 6 or title in seen:
                continue
            href = a.get('href', '')
            td = font.parent
            d = ''
            if td:
                span = td.find('span', class_='hui12')
                if span:
                    d = _extract_date(span.get_text())
            seen.add(title)
            items.append(_make_item(title, _abs_url('http://www.pbc.gov.cn', href), d, 'pbc'))
    if not items:
        return _fetch_search_news('中国人民银行', 'pbc')
    return items[:25]


def _fetch_mof():
    """财政部 财政新闻"""
    resp = _safe_get('http://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/')
    if not resp:
        return _fetch_search_news('财政部', 'mof')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for li in soup.select('li'):
        a = li.find('a')
        if not a:
            continue
        title = a.get_text(strip=True) or a.get('title', '')
        if len(title) < 6 or title in seen:
            continue
        href = a.get('href', '')
        if not href:
            continue
        # Filter out navigation links (no date, short path, category pages)
        span = li.find('span')
        d = _extract_date(span.get_text() if span else '')
        if not d and not re.search(r'/\d{6}/t\d{8}_', href):
            continue  # skip items without date AND without date-pattern in URL
        seen.add(title)
        items.append(_make_item(title, _abs_url('http://www.mof.gov.cn/zhengwuxinxi/caizhengxinwen/', href), d, 'mof'))
    return items[:15]


def _fetch_ndrc():
    """发改委 新闻发布 + 政策解读 + 通知公告"""
    urls = [
        'https://www.ndrc.gov.cn/xwdt/xwfb/',
        'https://www.ndrc.gov.cn/xwdt/xwjd/',
        'https://www.ndrc.gov.cn/xwdt/tzgg/',
    ]
    items = []
    seen = set()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for li in soup.select('li'):
            a = li.find('a')
            if not a:
                continue
            title = a.get_text(strip=True) or a.get('title', '')
            if len(title) < 4 or title in seen:
                continue
            href = a.get('href', '')
            span = li.find('span')
            d = _extract_date(span.get_text() if span else '')
            seen.add(title)
            items.append(_make_item(title, _abs_url(page_url, href), d, 'ndrc'))
    if not items:
        return _fetch_search_news('发改委', 'ndrc')
    return items[:25]


def _fetch_csrc():
    """证监会 — 新闻发布页(xwfb) + 公开征求意见(zjhgkyjj)"""
    urls = [
        'http://www.csrc.gov.cn/csrc/xwfb/index.shtml',
        'http://www.csrc.gov.cn/csrc/zjhgkyjj/index.shtml',
    ]
    items = []
    seen_urls = set()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href]'):
            href = a.get('href', '')
            if 'content.shtml' not in href:
                continue
            title = a.get_text(strip=True) or a.get('title', '')
            if len(title) < 4:
                continue
            full_url = _abs_url('http://www.csrc.gov.cn', href)
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)
            # CSRC URL pattern: /c100028/202604/t20260407_xxx.shtml
            m_date = re.search(r'/t(\d{4})(\d{2})(\d{2})_', href)
            if m_date:
                d = f'{m_date.group(1)}-{m_date.group(2)}-{m_date.group(3)}'
            else:
                d = _extract_date(href)
            items.append(_make_item(title, full_url, d, 'csrc'))
    if not items:
        return _fetch_search_news('证监会', 'csrc')
    return items[:20]


def _fetch_nfra():
    """金监总局 — use official JSON API at /cbircweb/ (JS SPA but API is public)."""
    # Target sections: 监管动态(915), 政策解读(916), 领导活动(919)
    api_url = 'https://www.nfra.gov.cn/cbircweb/DocInfo/SelectItemAndDocByItemPId?itemId=914&pageSize=10'
    try:
        resp = requests.get(api_url, headers={'User-Agent': _UA}, timeout=12,
                            proxies=_NO_PROXY, verify=False)
        if not resp.ok:
            return _fetch_search_news('金融监管总局', 'nfra')
        data = resp.json()
        if data.get('rptCode') != 200:
            return _fetch_search_news('金融监管总局', 'nfra')
    except Exception as e:
        logger.warning(f'NFRA API failed: {e}')
        return _fetch_search_news('金融监管总局', 'nfra')

    items, seen = [], set()
    # Prioritize: 监管动态 > 政策解读 > 领导活动 > others
    priority_ids = {915, 916, 919}
    sections = data.get('data', [])
    # Sort sections: priority first
    sections.sort(key=lambda s: 0 if s.get('itemId') in priority_ids else 1)

    for sec in sections:
        sec_name = sec.get('itemName', '')
        # Skip 图片新闻 and 新闻发言人
        if sec_name in ('图片新闻', '新闻发言人'):
            continue
        for doc in sec.get('docInfoVOList', []):
            title = (doc.get('docTitle') or '').strip()
            if not title or len(title) < 6 or title in seen:
                continue
            seen.add(title)
            doc_id = doc.get('docId', '')
            item_id = sec.get('itemId', '')
            # Use titleLink if it's an external link, otherwise build detail URL
            ext_link = doc.get('titleLink', '') if doc.get('isTitleLink') == '1' else ''
            if ext_link and ext_link.startswith('http'):
                url = ext_link
            else:
                url = f'https://www.nfra.gov.cn/cn/view/pages/ItemDetail.html?docId={doc_id}&itemId={item_id}'
            d = (doc.get('publishDate') or '')[:10]
            item = _make_item(title, url, d, 'nfra')
            # Attach PDF link for direct viewing
            pdf_path = doc.get('pdfFileUrl', '')
            if pdf_path:
                item['pdf_url'] = f'https://www.nfra.gov.cn{pdf_path}'
            items.append(item)

    items.sort(key=lambda x: x.get('date', ''), reverse=True)
    if items:
        logger.warning(f'NFRA API: {len(items)} items')
        return items[:15]
    return _fetch_search_news('金融监管总局', 'nfra')


def _fetch_gov_yaowen():
    """国务院要闻 — yaowen/liebiao JSON API (政府工作报告、规划纲要等)."""
    try:
        resp = _safe_get('https://www.gov.cn/yaowen/liebiao/YAOWENLIEBIAO.json')
        if not resp:
            return _fetch_search_news('国务院 要闻', 'gov_yaowen')
        data = resp.json()
        items = []
        for entry in data:
            title = entry.get('TITLE', '').strip()
            url = entry.get('URL', '').strip()
            d = entry.get('DOCRELPUBTIME', '').strip()
            if not title or not url or len(title) < 4:
                continue
            if not url.startswith('http'):
                url = 'https://www.gov.cn' + url
            items.append(_make_item(title, url, d, 'gov_yaowen'))
        return items[:25]
    except Exception as e:
        logger.warning(f'[gov] gov_yaowen JSON parse failed: {e}')
        return _fetch_search_news('国务院 要闻', 'gov_yaowen')


def _fetch_gov():
    """国务院 政策文件 — pushinfo li/a + span date."""
    resp = _safe_get('https://www.gov.cn/pushinfo/v150203/')
    if not resp:
        return _fetch_search_news('国务院 政策', 'gov')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    for li in soup.select('li'):
        a = li.find('a')
        span = li.find('span')
        if not a or not span:
            continue
        title = a.get_text(strip=True)
        if len(title) < 6:
            continue
        href = a.get('href', '')
        if not href or href.startswith('javascript'):
            continue
        d = _extract_date(span.get_text())
        if not d:
            continue
        items.append(_make_item(title, _abs_url('https://www.gov.cn', href), d, 'gov'))
    return items[:25]


def _fetch_stats():
    """国家统计局 最新发布 + 数据解读"""
    urls = [
        'https://www.stats.gov.cn/sj/zxfb/',
        'https://www.stats.gov.cn/sj/sjjd/',
    ]
    # Navigation / sidebar link titles to reject
    _nav_titles = {
        '时政要闻', '统计新闻', '部门新闻', '地方新闻', '统计公报',
        '中央人民政府门户网站', '国家发展改革委', '工业和信息化部',
        '财政部', '商务部', '中国人民银行', '海关总署', '国家税务总局',
        '更多', '首页', '数据发布', '统计知识', '数据解读',
    }
    items = []
    seen = set()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for li in soup.select('li'):
            a = li.find('a')
            if not a:
                continue
            title = a.get_text(strip=True) or a.get('title', '')
            if len(title) < 8 or title in seen or title in _nav_titles:
                continue
            href = a.get('href', '')
            # Must be a stats.gov.cn article link
            full_url = _abs_url(page_url, href)
            if 'stats.gov.cn' not in full_url:
                continue
            span = li.find('span')
            d = _extract_date(span.get_text() if span else '')
            seen.add(title)
            items.append(_make_item(title, full_url, d, 'stats'))
    if not items:
        return _fetch_search_news('国家统计局', 'stats')
    return items[:20]


def _fetch_qiushi():
    """求是 homepage articles — filter by qstheory.cn article URLs."""
    resp = _safe_get('http://www.qstheory.cn/')
    if not resp:
        return _fetch_search_news('求是', 'qiushi')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        # Only article pages (with /c.html or date-based paths)
        if not (href.endswith('/c.html') or href.endswith('.htm') or href.endswith('.html')):
            continue
        # Skip index/category pages
        if '/index.' in href or '/v9zhuanqu/' in href:
            continue
        d = ''
        m = re.search(r'/(\d{4})(\d{2})(\d{2})/', href) or re.search(r'/(\d{4})-(\d{2})/(\d{2})/', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        items.append(_make_item(title, _abs_url('http://www.qstheory.cn', href), d, 'qiushi'))
    # Dedup by URL (not title) — same article may have multiple link texts on page
    seen_urls = set()
    result = []
    for item in items:
        if item['url'] not in seen_urls:
            seen_urls.add(item['url'])
            result.append(item)
    return result[:15]


def _fetch_cpc():
    """反腐频道 — fanfu.people.com.cn (替代CCDI被CAPTCHA封锁)"""
    resp = _safe_get('http://fanfu.people.com.cn/')
    if not resp:
        return _fetch_search_news('中央纪委', 'cpc')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8 or title in seen:
            continue
        href = a.get('href', '')
        if not href or not (href.endswith('.html') or href.endswith('.htm')):
            continue
        # People.com.cn pattern: /n1/2026/0313/c64371-40681119.html
        d = ''
        m = re.search(r'/n1/(\d{4})/(\d{2})(\d{2})/c', href)
        if not m:
            m = re.search(r'/(\d{4})/(\d{2})(\d{2})/', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        if not d:
            continue
        seen.add(title)
        items.append(_make_item(title, _abs_url('http://fanfu.people.com.cn', href), d, 'cpc'))
    return items[:20]


def _fetch_people_overseas():
    """人民日报海外版 — 需跟随 META REFRESH 到 pc/layout/index.html，再爬取各版面文章"""
    BASE = 'http://paper.people.com.cn/rmrbhwb/'
    INDEX = f'{BASE}pc/layout/index.html'
    # Step 1: fetch section index (skip META REFRESH chain, go directly)
    # Force utf-8: paper.people.com.cn sometimes returns wrong apparent_encoding (ptcp154)
    resp = _safe_get(INDEX, encoding='utf-8')
    if not resp:
        return _fetch_search_news('人民日报海外版', 'people_overseas')
    soup = BeautifulSoup(resp.text, 'html.parser')
    # Step 2: collect section page URLs (node_01.html ~ node_04.html for 要闻/台港澳/速览)
    section_urls = []
    for a in soup.select('a[href*="node_"]'):
        href = a.get('href', '')
        if href:
            section_urls.append(_abs_url(INDEX, href))
    # Step 3: crawl first 4 sections for article links
    items = []
    # Editor/footer patterns to reject
    _reject_re = re.compile(r'^责编[:：]|^编辑[:：]|^邮箱[:：]')
    for sec_url in section_urls[:4]:
        sec_resp = _safe_get(sec_url, encoding='utf-8')
        if not sec_resp:
            continue
        sec_soup = BeautifulSoup(sec_resp.text, 'html.parser')
        for a in sec_soup.select('a[href*="content_"]'):
            title = a.get_text(strip=True)
            if len(title) < 6:
                continue
            # Skip "图片报道" and editor lines
            if title in ('图片报道',) or _reject_re.search(title):
                continue
            href = a.get('href', '')
            if not (href.endswith('.htm') or href.endswith('.html')):
                continue
            d = ''
            m = re.search(r'/(\d{4})(\d{2})/(\d{2})/', href) or re.search(r'/(\d{4})-(\d{2})/(\d{2})/', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
            items.append(_make_item(title, _abs_url(sec_url, href), d, 'people_overseas'))
    seen_urls = set()
    result = []
    for item in items:
        if item['url'] not in seen_urls:
            seen_urls.add(item['url'])
            result.append(item)
    return result[:15]


# ── 财经媒体 fetchers ─────────────────────────────────────────────────────

def _fetch_caixin():
    """财新 — caixin.com article links with /YYYY-MM-DD/ date pattern."""
    resp = _safe_get('https://www.caixin.com/')
    if not resp:
        return _fetch_search_news('财新网', 'caixin')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if 'caixin.com' not in href:
            continue
        # Match /2026-03-11/102421857.html
        m = re.search(r'/(\d{4})-(\d{2})-(\d{2})/', href)
        if not m:
            continue
        d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, href, d, 'caixin'))
    return items[:25]


def _fetch_yicai():
    """第一财经 — yicai.com /news/ articles."""
    resp = _safe_get('https://www.yicai.com/')
    if not resp:
        return _fetch_search_news('第一财经', 'yicai')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    today = date.today().isoformat()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if '/news/' not in href and '/article/' not in href:
            continue
        if not (href.endswith('.html') or re.search(r'/\d{9,}', href)):
            continue
        url = _abs_url('https://www.yicai.com', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, today, 'yicai'))
    return items[:25]


def _fetch_stcn():
    """证券时报 — stcn.com /article/detail/ links."""
    resp = _safe_get('https://www.stcn.com/')
    if not resp:
        return _fetch_search_news('证券时报', 'stcn')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    today = date.today().isoformat()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if '/article/detail/' not in href:
            continue
        url = _abs_url('https://www.stcn.com', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, today, 'stcn'))
    return items[:25]


def _fetch_cs():
    """中国证券报 — cs.com.cn /xwzx/ articles with t20260311_ date pattern."""
    resp = _safe_get('https://www.cs.com.cn/')
    if not resp:
        return _fetch_search_news('中国证券报', 'cs')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if not (href.endswith('.html') or href.endswith('.htm')):
            continue
        if '/index.' in href:
            continue
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        url = _abs_url('https://www.cs.com.cn', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, d, 'cs'))
    return items[:25]


def _fetch_cnstock():
    """上海证券报 — news.cnstock.com /commonDetail/ articles."""
    resp = _safe_get('https://news.cnstock.com/')
    if not resp:
        return _fetch_search_news('上海证券报', 'cnstock')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    today = date.today().isoformat()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if '/commonDetail/' not in href:
            continue
        url = _abs_url('https://www.cnstock.com', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, today, 'cnstock'))
    return items[:25]


def _fetch_jingji21():
    """21世纪经济报道 — 21jingji.com /article/ links."""
    resp = _safe_get('https://www.21jingji.com/')
    if not resp:
        return _fetch_search_news('21世纪经济', 'jingji21')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if '/article/' not in href:
            continue
        if not href.endswith('.html'):
            continue
        d = ''
        m = re.search(r'/article/(\d{4})(\d{2})(\d{2})/', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        url = _abs_url('https://www.21jingji.com', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, d, 'jingji21'))
    return items[:25]


def _fetch_nbd():
    """每日经济新闻 — 宏观 + 金融"""
    urls = [
        'https://economy.nbd.com.cn/',
        'https://finance.nbd.com.cn/',
    ]
    items = []
    seen = set()
    today = date.today().isoformat()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href]'):
            title = a.get_text(strip=True)
            if len(title) < 8 or title in seen:
                continue
            href = a.get('href', '')
            if '/articles/' not in href:
                continue
            if not href.endswith('.html'):
                continue
            d = ''
            m = re.search(r'/articles/(\d{4})-(\d{2})-(\d{2})/', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
            if not d:
                d = today
            url = _abs_url('https://www.nbd.com.cn', href)
            seen.add(title)
            items.append(_make_item(title, url, d, 'nbd'))
    if not items:
        return _fetch_search_news('每日经济新闻', 'nbd')
    return items[:25]


def _fetch_jiemian():
    """界面新闻 — 宏观 + 金融"""
    urls = [
        'https://www.jiemian.com/lists/174.html',
        'https://www.jiemian.com/lists/9.html',
    ]
    items = []
    seen = set()
    today = date.today().isoformat()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href]'):
            title = a.get_text(strip=True)
            if len(title) < 8 or title in seen:
                continue
            href = a.get('href', '')
            if '/article/' not in href:
                continue
            if not href.endswith('.html'):
                continue
            url = _abs_url('https://www.jiemian.com', href)
            seen.add(title)
            items.append(_make_item(title, url, today, 'jiemian'))
    if not items:
        return _fetch_search_news('界面新闻', 'jiemian')
    return items[:25]


def _fetch_jjckb():
    """经济参考报 — 要闻 + 金融"""
    urls = [
        'http://www.jjckb.cn/yw.htm',
        'http://www.jjckb.cn/financial.htm',
    ]
    items = []
    seen = set()
    for page_url in urls:
        resp = _safe_get(page_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        for a in soup.select('a[href]'):
            title = a.get_text(strip=True)
            if len(title) < 8 or title in seen:
                continue
            href = a.get('href', '')
            if not (href.endswith('.html') or href.endswith('.htm')):
                continue
            if '/index.' in href:
                continue
            d = ''
            m = re.search(r'/(\d{4})(\d{2})(\d{2})/', href) or re.search(r'/(\d{4})-(\d{2})/(\d{2})/', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
            url = _abs_url('http://www.jjckb.cn', href)
            seen.add(title)
            items.append(_make_item(title, url, d, 'jjckb'))
    if not items:
        return _fetch_search_news('经济参考报', 'jjckb')
    return items[:25]


def _fetch_eeo():
    """经济观察报 — 首页 .shtml 文章链接"""
    resp = _safe_get('https://www.eeo.com.cn/')
    if not resp:
        return _fetch_search_news('经济观察报', 'eeo')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8 or title in seen:
            continue
        href = a.get('href', '')
        if not href.endswith('.shtml') and not href.endswith('.html'):
            continue
        if '/index.' in href:
            continue
        d = ''
        m = re.search(r'/(\d{4})/(\d{2})(\d{2})/', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        url = _abs_url('https://www.eeo.com.cn', href)
        seen.add(title)
        items.append(_make_item(title, url, d, 'eeo'))
    if not items:
        return _fetch_search_news('经济观察报', 'eeo')
    return items[:25]


def _fetch_bse():
    """北交所 — 本所动态"""
    resp = _safe_get('https://www.bse.cn/important_news.html', encoding='utf-8')
    if not resp:
        return _fetch_search_news('北交所 北交所上市', 'bse')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True) or a.get('title', '')
        if len(title) < 6 or title in seen:
            continue
        href = a.get('href', '')
        if not href:
            continue
        if not (href.endswith('.html') or href.endswith('.htm')):
            continue
        if '/index.' in href:
            continue
        # Only accept bse.cn domain links
        full_url = _abs_url('https://www.bse.cn', href)
        if 'bse.cn' not in full_url:
            continue
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        else:
            m = re.search(r'/(\d{4})(\d{2})(\d{2})', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        seen.add(title)
        items.append(_make_item(title, full_url, d, 'bse'))
    if not items:
        return _fetch_search_news('北交所 北交所上市', 'bse')
    return items[:15]


def _fetch_thepaper():
    """澎湃新闻 — 首页 newsDetail_forward_ 文章链接"""
    resp = _safe_get('https://www.thepaper.cn/')
    if not resp:
        return _fetch_search_news('澎湃新闻', 'thepaper')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    today = date.today().isoformat()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8 or title in seen:
            continue
        href = a.get('href', '')
        if '/newsDetail_forward_' not in href:
            continue
        url = _abs_url('https://www.thepaper.cn', href)
        seen.add(title)
        items.append(_make_item(title, url, today, 'thepaper'))
    if not items:
        return _fetch_search_news('澎湃新闻', 'thepaper')
    return items[:25]


# ── 智库 fetchers ─────────────────────────────────────────────────────────

def _fetch_cssn():
    """中国社科院 — cssn.cn articles with t20260311_ date pattern."""
    resp = _safe_get('http://www.cssn.cn/')
    if not resp:
        return _fetch_search_news('中国社科院', 'cssn')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if not (href.endswith('.shtml') or href.endswith('.html') or href.endswith('.htm')):
            continue
        if '/index.' in href:
            continue
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        url = _abs_url('http://www.cssn.cn', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, d, 'cssn'))
    return items[:25]


def _fetch_ciis():
    """国际问题研究院 — ciis.org.cn articles."""
    resp = _safe_get('https://www.ciis.org.cn/')
    if not resp:
        return _fetch_search_news('国际问题研究院', 'ciis')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if not (href.endswith('.html') or href.endswith('.htm')):
            continue
        if '/index.' in href or '/pages/' in href:
            continue
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        url = _abs_url('https://www.ciis.org.cn', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, d, 'ciis'))
    return items[:20]


# ── 领导活动 fetchers ──────────────────────────────────────────────────────

_TOP_LEADERS = ['习近平', '李强', '赵乐际', '王沪宁', '蔡奇', '丁薛祥', '韩正']


def _fetch_leaders():
    """高层动态 — people.com.cn 领导人活动专页 (li>a + em date).
    Results sorted by leader priority (top leaders first), then by date."""
    resp = _safe_get('http://politics.people.com.cn/GB/1024/index1.html')
    if not resp:
        return _fetch_search_news('国家领导人活动 国务院', 'leaders')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for li in soup.select('li'):
        a = li.find('a')
        em = li.find('em')
        if not a or not em:
            continue
        title = a.get_text(strip=True)
        if len(title) < 6 or title in seen:
            continue
        href = a.get('href', '')
        d = _extract_date(em.get_text())
        if not d:
            m = re.search(r'/(\d{4})/(\d{2})(\d{2})/', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        if not d:
            continue
        seen.add(title)
        item = _make_item(title, _abs_url('http://politics.people.com.cn', href), d, 'leaders')
        # Assign leader priority (lower = higher priority)
        priority = len(_TOP_LEADERS)  # default: lower than any named leader
        for idx, name in enumerate(_TOP_LEADERS):
            if name in title:
                priority = idx
                break
        item['_priority'] = priority
        items.append(item)
    # Sort by priority ASC then date DESC (negate date by inverting string)
    def _sort_key(x):
        p = x.pop('_priority', 99)
        d = x.get('date', '')
        # Invert date string for descending sort: '2026-04-08' → negative
        return (p, [-ord(c) for c in d] if d else [0])
    items.sort(key=_sort_key)
    return items[:30]


def _fetch_xinhua_leaders():
    """新华网领导活动专栏"""
    return _fetch_gov_generic('http://www.news.cn/politics/leaders/', 'xinhua_leaders')


def _fetch_gov_premier():
    """国务院总理活动"""
    return _fetch_gov_generic('https://www.gov.cn/premier/', 'gov_premier',
                              base_url='https://www.gov.cn')


def _fetch_pbc_governor():
    """人民银行行长活动"""
    items = _fetch_gov_generic('http://www.pbc.gov.cn/hangzhang/', 'pbc_governor',
                               base_url='http://www.pbc.gov.cn')
    if not items:
        return _fetch_search_news('央行行长 潘功胜', 'pbc_governor')
    return items


def _fetch_mof_minister():
    """财政部部长活动"""
    return _fetch_gov_generic('http://www.mof.gov.cn/zhengwuxinxi/buzhanghuodong/', 'mof_minister',
                              base_url='http://www.mof.gov.cn')


def _fetch_ndrc_chairman():
    """发改委主任活动"""
    return _fetch_gov_generic('https://www.ndrc.gov.cn/xxgk/ldxx/', 'ndrc_chairman',
                              base_url='https://www.ndrc.gov.cn')


def _fetch_csrc_chairman():
    """证监会主席活动"""
    items = _fetch_gov_generic('http://www.csrc.gov.cn/zjhxwfb/xwdd/zjhlddt/', 'csrc_chairman',
                               base_url='http://www.csrc.gov.cn')
    if not items:
        return _fetch_search_news('证监会主席 吴清', 'csrc_chairman')
    return items


def _fetch_nfra_chairman():
    """金监总局局长活动"""
    return _fetch_gov_generic('https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemPId=923', 'nfra_chairman',
                              base_url='https://www.nfra.gov.cn')


def _fetch_mofcom_minister():
    """商务部部长活动"""
    return _fetch_gov_generic('http://www.mofcom.gov.cn/article/i/jyjl/', 'mofcom_minister',
                              base_url='http://www.mofcom.gov.cn')


def _fetch_mfa_spokesman():
    """外交部发言人例行记者会"""
    return _fetch_gov_generic('https://www.mfa.gov.cn/web/fyrbt_673021/', 'mfa_spokesman',
                              base_url='https://www.mfa.gov.cn')


def _fetch_safe_director():
    """外汇局局长活动"""
    return _fetch_gov_generic('https://www.safe.gov.cn/safe/rdjj/index.html', 'safe_director',
                              base_url='https://www.safe.gov.cn')


def _fetch_miit_minister():
    """工信部部长活动"""
    return _fetch_gov_generic('https://www.miit.gov.cn/gzcy/bzhdxwfbh/ld/', 'miit_minister',
                              base_url='https://www.miit.gov.cn')


def _fetch_mohrss_minister():
    """人社部部长活动"""
    return _fetch_gov_generic('http://www.mohrss.gov.cn/SYrlzyhshbzb/dongtaixinwen/buneiyaowen/', 'mohrss_minister',
                              base_url='http://www.mohrss.gov.cn')


def _fetch_mohurd_minister():
    """住建部部长活动"""
    return _fetch_gov_generic('https://www.mohurd.gov.cn/xinwen/lingdaohuodong/', 'mohurd_minister',
                              base_url='https://www.mohurd.gov.cn')


def _fetch_mot_minister():
    """交通部部长活动"""
    return _fetch_gov_generic('https://www.mot.gov.cn/', 'mot_minister')


def _fetch_moa_minister():
    """农业部部长活动"""
    return _fetch_gov_generic('http://www.moa.gov.cn/xw/bmdt/', 'moa_minister',
                              base_url='http://www.moa.gov.cn')


def _fetch_most_minister():
    """科技部部长活动"""
    return _fetch_gov_generic('https://www.most.gov.cn/kjbgz/', 'most_minister',
                              base_url='https://www.most.gov.cn')


def _fetch_mee_minister():
    """环境部部长活动"""
    return _fetch_gov_generic('https://www.mee.gov.cn/home/bzhdt/', 'mee_minister',
                              base_url='https://www.mee.gov.cn')


def _fetch_nhc_director():
    """卫健委主任活动"""
    return _fetch_gov_generic('http://www.nhc.gov.cn/wjw/ldxx/list.shtml', 'nhc_director',
                              base_url='http://www.nhc.gov.cn')


def _fetch_mem_minister():
    """应急部部长活动"""
    return _fetch_gov_generic('https://www.mem.gov.cn/gk/ldxx/', 'mem_minister',
                              base_url='https://www.mem.gov.cn')


def _fetch_sasac_director():
    """国资委主任活动"""
    return _fetch_gov_generic('http://www.sasac.gov.cn/n2588025/n2588119/index.html', 'sasac_director',
                              base_url='http://www.sasac.gov.cn')


# ── 纪检监察 fetchers ──────────────────────────────────────────────────────

def _fetch_ccdi_inspect():
    """审查调查通报 — 通过澎湃新闻API搜索(CCDI被CAPTCHA封锁)."""
    import json as _json
    today = date.today().isoformat()
    items = []
    seen = set()
    try:
        r = requests.post(
            'https://api.thepaper.cn/search/web/news',
            json={'word': '审查调查', 'orderType': 1, 'pageNum': 1, 'pageSize': 20},
            timeout=15, headers={'User-Agent': _UA, 'Content-Type': 'application/json'},
        )
        if r.status_code != 200:
            return []
        data = r.json()
        for item in data.get('data', {}).get('list', []):
            name = item.get('name', '')
            # Strip HTML highlight tags
            name = re.sub(r'<[^>]+>', '', name).strip()
            if not name or len(name) < 8 or name in seen:
                continue
            cont_id = item.get('contId', '')
            url = f'https://www.thepaper.cn/newsDetail_forward_{cont_id}' if cont_id else ''
            if not url:
                continue
            # Extract date from pubTimeLong (milliseconds) or pubTime
            d = ''
            pub_time = item.get('pubTime', '')
            if pub_time:
                m = re.search(r'(\d{4}-\d{2}-\d{2})', pub_time)
                if m:
                    d = m.group(1)
            if not d:
                d = today
            seen.add(name)
            items.append(_make_item(name, url, d, 'ccdi_inspect'))
    except Exception as e:
        logger.warning(f'[gov] ccdi_inspect thepaper API error: {e}')
    return items[:20]


# ── 审计 fetchers ──────────────────────────────────────────────────────────

def _fetch_audit():
    """审计署 — audit.gov.cn/n4/n19/ (审计要闻) + /n4/n18/ (时政要闻).
    HTML: <dt class="fl"><a title="..." href="...">标题</a></dt>
          <dd class="fr"><a href="...">[03-10]</a></dd>
    """
    items = []
    seen = set()
    for section_url in [
        'http://www.audit.gov.cn/n4/n19/index.html',
        'http://www.audit.gov.cn/n4/n18/index.html',
    ]:
        resp = _safe_get(section_url)
        if not resp:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        # Only pick up title links inside <dt> elements
        for dt in soup.select('dt.fl'):
            a = dt.find('a', href=True)
            if not a:
                continue
            # Use title attr (clean) or fall back to text
            title = (a.get('title', '') or a.get_text(strip=True)).strip()
            title = title.lstrip('.')
            if len(title) < 6 or title in seen:
                continue
            href = a.get('href', '')
            if 'content.html' not in href:
                continue
            # Find sibling <dd class="fr"> for date
            d = ''
            dd = dt.find_next_sibling('dd', class_='fr')
            if dd:
                dd_text = dd.get_text(strip=True)
                m_date = re.search(r'\[(\d{2})-(\d{2})\]', dd_text)
                if m_date:
                    d = f'{date.today().year}-{m_date.group(1)}-{m_date.group(2)}'
            seen.add(title)
            url = _abs_url('http://www.audit.gov.cn', href)
            items.append(_make_item(title, url, d, 'audit'))
    if not items:
        return _fetch_search_news('审计署', 'audit')
    return items[:25]


# ── Baidu news search fallback (for WAF/JS-blocked ministry sites) ────────

def _baidu_relative_to_date(text):
    """Convert Baidu relative time ('昨天', '3天前', '7小时前') to ISO date."""
    today = date.today()
    if not text:
        return today.isoformat()
    text = text.strip()
    if '刚刚' in text or '分钟前' in text or '小时前' in text:
        return today.isoformat()
    if '昨天' in text:
        return (today - timedelta(days=1)).isoformat()
    if '前天' in text:
        return (today - timedelta(days=2)).isoformat()
    m = re.match(r'(\d+)\s*天前', text)
    if m:
        return (today - timedelta(days=int(m.group(1)))).isoformat()
    m = re.search(r'(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})', text)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'
    return today.isoformat()


def _is_official_domain(url):
    """Check if a URL is from an official government or authoritative media domain."""
    from urllib.parse import urlparse
    domain = urlparse(url).netloc.lower()
    if not domain:
        return False
    # Government domains
    if domain.endswith('.gov.cn'):
        return True
    # Central media / authoritative sources
    _OFFICIAL_MEDIA = {
        'people.com.cn', 'news.cn', 'xinhua.net', 'cctv.com', 'ce.cn',
        'cnr.cn', 'chinadaily.com.cn', 'gmw.cn', 'youth.cn', 'china.com.cn',
        'chinanews.com', 'chinanews.com.cn', 'stcn.com', 'cs.com.cn',
        'securities.com', 'hexun.com',
    }
    for m in _OFFICIAL_MEDIA:
        if domain == m or domain.endswith('.' + m):
            return True
    return False


def _fetch_search_news(keyword, source_key, n=10):
    """Fetch news via search engine for WAF/JS-blocked ministry sites.
    Tries Sogou News first, falls back to Baidu News.
    Prioritizes results from .gov.cn and official media domains.
    Returns standardized news items with titles, URLs, and dates."""
    # Junk title filter
    _JUNK = {'官方微博', '官方网站', '官网', '百度百科', '网站首页',
             '会议活动', '政务公开', '信息公开', '政策文件', '图片新闻',
             '人社新闻', '金色相框', '卫生健康委员会', '卫健委员会',
             '人力资源和社会保障局', '中华人民共和国海关'}
    # Domains that can't be fetched (WAF/captcha/SPA) — skip these search results
    _UNFETCHABLE_DOMAINS = {'baijiahao.baidu.com', 'xueqiu.com', 'zhihu.com',
                            'weibo.com', 'douyin.com', 'xiaohongshu.com'}
    cutoff = (date.today() - timedelta(days=30)).isoformat()

    def _make_search_item(title, href, d, src_key):
        """Create item and mark non-official sources. Returns None for unfetchable URLs.
        Auto-recovers truncated titles (ending with ... or …) by fetching og:title/h1."""
        from urllib.parse import urlparse
        domain = urlparse(href).hostname or ''
        for uf in _UNFETCHABLE_DOMAINS:
            if domain == uf or domain.endswith('.' + uf):
                return None
        # Recover truncated titles
        if title.endswith('...') or title.endswith('…'):
            try:
                resp = _safe_get(href, timeout=5, retries=0)
                if resp and resp.ok:
                    s = BeautifulSoup(resp.text, 'html.parser')
                    og = s.find('meta', property='og:title')
                    full = (og['content'].strip() if og and og.get('content') else '') or \
                           (s.find('h1').get_text(strip=True) if s.find('h1') else '') or \
                           (s.find('title').get_text(strip=True) if s.find('title') else '')
                    if full and len(full) > len(title):
                        title = full
            except Exception:
                pass
        item = _make_item(title, href, d, src_key)
        if not _is_official_domain(href):
            item['via_search'] = True
        return item

    def _sort_by_official(items):
        """Sort: official domains first, then by date."""
        items = [i for i in items if i is not None]
        official = [i for i in items if not i.get('via_search')]
        coverage = [i for i in items if i.get('via_search')]
        official.sort(key=lambda x: x.get('date', ''), reverse=True)
        coverage.sort(key=lambda x: x.get('date', ''), reverse=True)
        return official + coverage

    def _parse_results_sogou(html):
        soup = BeautifulSoup(html, 'html.parser')
        items, seen = [], set()
        for div in soup.select('div.vrwrap'):
            h3 = div.find('h3')
            if not h3:
                continue
            a = h3.find('a')
            if not a:
                continue
            title = a.get_text(strip=True)
            if not title or len(title) < 8 or title in seen:
                continue
            if any(j in title for j in _JUNK):
                continue
            # Skip homepage-like short results
            stripped = re.sub(r'[- —_·|]', '', title)
            if len(stripped) < 10:
                continue
            href = a.get('href', '')
            if not href or href.startswith('/link?'):
                # Sogou redirect — skip, we can't resolve without following
                continue
            seen.add(title)
            # Extract date from Tencent News URL pattern: /20260313A07VPR00
            d = ''
            m = re.search(r'/(\d{4})(\d{2})(\d{2})[A-Z]', href)
            if m:
                d = _validate_date(f'{m.group(1)}-{m.group(2)}-{m.group(3)}')
            if not d:
                d = date.today().isoformat()
            if d < cutoff:
                continue
            items.append(_make_search_item(title, href, d, source_key))
        return _sort_by_official(items)

    def _parse_results_baidu(html):
        soup = BeautifulSoup(html, 'html.parser')
        items, seen = [], set()
        for div in soup.select('div.result-op, div.result'):
            h3 = div.find('h3')
            if not h3:
                continue
            a = h3.find('a')
            if not a:
                continue
            title = a.get_text(strip=True)
            if not title or len(title) < 8 or title in seen:
                continue
            if any(j in title for j in _JUNK):
                continue
            href = a.get('href', '')
            if not href:
                continue
            # Skip homepage results
            stripped = re.sub(r'[- —_·|]', '', title)
            if len(stripped) < 10:
                continue
            seen.add(title)
            crow = div.find('div', class_='c-row')
            crow_text = crow.get_text(strip=True)[:30] if crow else ''
            d = _validate_date(_baidu_relative_to_date(crow_text)) or date.today().isoformat()
            if d < cutoff:
                continue
            items.append(_make_search_item(title, href, d, source_key))
        return _sort_by_official(items)

    def _parse_results_360(html):
        """Parse 360 News (news.so.com) results — returns direct URLs.
        Uses structured selectors: ul.result > li.res-list for each result,
        .g-title-inner for headline text (avoids grabbing snippet body text)."""
        soup = BeautifulSoup(html, 'html.parser')
        items, seen = [], set()
        # Structured approach: iterate search result items
        result_items = soup.select('ul.result > li.res-list')
        if not result_items:
            # Fallback: older 360 layout
            result_items = soup.select('li.res-list')
        for li in result_items:
            a = li.find('a', href=True)
            if not a:
                continue
            href = a.get('href', '')
            if not href or 'so.com' in href or '360.cn' in href or '360kuai.com' in href:
                continue
            # Get clean title from .g-title-inner (headline only, not snippet)
            title_el = li.select_one('.g-title-inner')
            title = title_el.get_text(strip=True) if title_el else ''
            if not title:
                # Fallback: use <a> text but strip snippet (.g-txt-inner)
                snippet_el = a.select_one('.g-txt-inner')
                if snippet_el:
                    snippet_el.decompose()
                title = a.get_text(strip=True)
            # Strip leading/trailing ellipsis (360 truncates long titles with ...)
            title = re.sub(r'^\.{2,}|^…', '', title).strip()
            title = re.sub(r'\.{3,}$|…$', '', title).strip()
            if not title or len(title) < 10 or title in seen:
                continue
            if any(j in title for j in _JUNK):
                continue
            # Safety: only truncate extremely long titles (>200 chars)
            if len(title) > 200:
                title = title[:195] + '...'
            stripped = re.sub(r'[- —_·|]', '', title)
            if len(stripped) < 10:
                continue
            seen.add(title)
            d = ''
            # chinanews: /2026/03-25/xxx  or /202603/t20260325_
            m = re.search(r'/(20\d{2})/(\d{2})-(\d{2})/', href) or \
                re.search(r'/(20\d{2})(\d{2})/t(\d{2})', href) or \
                re.search(r'/(20\d{2})(\d{2})(\d{2})[_/\.]', href)
            if m:
                y, mo, dy = m.group(1), m.group(2), m.group(3)
                if 1 <= int(mo) <= 12 and 1 <= int(dy) <= 31:
                    d = _validate_date(f'{y}-{mo}-{dy}')
            if not d:
                d = date.today().isoformat()
            if d < cutoff:
                continue
            items.append(_make_search_item(title, href, d, source_key))
        return _sort_by_official(items)

    # Try 360 News first (returns direct URLs, no redirect wrappers)
    so_url = f'https://news.so.com/ns?q={urlquote(keyword)}&src=news_home'
    try:
        resp = requests.get(so_url, headers={'User-Agent': _UA,
                            'Accept-Language': 'zh-CN,zh;q=0.9'},
                            timeout=15, proxies=_NO_PROXY, verify=False)
        resp.encoding = 'utf-8'
        if resp.ok and len(resp.text) > 5000:
            items = _parse_results_360(resp.text)
            if items:
                logger.warning(f'360 news [{keyword}]: {len(items)} items ({sum(1 for i in items if not i.get("via_search"))} official)')
                return items[:n]
    except Exception as e:
        logger.warning(f'360 news failed [{keyword}]: {e}')

    # Fallback 1: Sogou News
    sogou_url = (f'https://news.sogou.com/news?query={urlquote(keyword)}'
                 f'&mode=1&sort=0')
    try:
        resp = requests.get(sogou_url, headers={'User-Agent': _UA}, timeout=15,
                            proxies=_NO_PROXY, verify=False)
        resp.encoding = 'utf-8'
        if resp.ok and len(resp.text) > 10000 and 'captcha' not in resp.url:
            items = _parse_results_sogou(resp.text)
            if items:
                logger.warning(f'Sogou news [{keyword}]: {len(items)} items ({sum(1 for i in items if not i.get("via_search"))} official)')
                return items[:n]
    except Exception as e:
        logger.warning(f'Sogou news failed [{keyword}]: {e}')

    # Fallback 2: Baidu News — request more results to find official sources
    fetch_n = max(n * 2, 20)
    baidu_url = (f'https://news.baidu.com/ns?word={urlquote(keyword)}'
                 f'&pn=0&cl=2&ct=0&tn=news&rn={fetch_n}&ie=utf-8')
    try:
        sess = requests.Session()
        sess.headers.update({'User-Agent': _UA})
        resp = sess.get(baidu_url, timeout=15, proxies=_NO_PROXY, verify=False,
                        allow_redirects=True)
        resp.encoding = 'utf-8'
        if resp.ok and len(resp.text) > 10000 and 'captcha' not in resp.url:
            items = _parse_results_baidu(resp.text)
            if items:
                logger.warning(f'Baidu news [{keyword}]: {len(items)} items ({sum(1 for i in items if not i.get("via_search"))} official)')
                return items[:n]
    except Exception as e:
        logger.warning(f'Baidu news failed [{keyword}]: {e}')

    return []


def _fetch_search_news_multi(keywords, source_key, n=15):
    """Multi-keyword search with dedup for WAF-blocked ministry sites.
    Runs _fetch_search_news for each keyword, merges and deduplicates by URL."""
    all_items = []
    seen_urls = set()
    for kw in keywords:
        items = _fetch_search_news(kw, source_key, n=n)
        for item in items:
            url = item.get('url', '')
            if url and url not in seen_urls:
                seen_urls.add(url)
                all_items.append(item)
    # Sort: official domains first, then by date
    official = [i for i in all_items if not i.get('via_search')]
    coverage = [i for i in all_items if i.get('via_search')]
    official.sort(key=lambda x: x.get('date', ''), reverse=True)
    coverage.sort(key=lambda x: x.get('date', ''), reverse=True)
    result = (official + coverage)[:n]
    if result:
        logger.warning(f'Multi-keyword search [{source_key}]: {len(result)} items from {len(keywords)} keywords')
    return result


# ── 部委动态 fetchers ──────────────────────────────────────────────────────

def _fetch_gov_generic(url, source_key, base_url=None):
    """Generic gov.cn-style HTML scraper for ministry homepages.
    Falls back to search engine if scraping fails or returns empty."""
    resp = _safe_get(url)
    if not resp:
        name = GOV_SOURCES.get(source_key, {}).get('name', source_key)
        return _fetch_search_news(name, source_key)
    if base_url is None:
        base_url = url
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8 or title in seen:
            continue
        href = a.get('href', '')
        if not href or href.startswith('javascript'):
            continue
        if not (href.endswith('.html') or href.endswith('.htm') or href.endswith('.shtml')):
            continue
        if '/index.' in href or '/sitemap' in href:
            continue
        d = ''
        # Pattern 1: /202603/t20260313_xxx.html
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = _validate_date(f'{m.group(3)}-{m.group(4)}-{m.group(5)}')
        else:
            # Pattern 2: /2026/0313/xxx or /2026-03/13/
            m = re.search(r'/(\d{4})/(\d{2})(\d{2})/', href) or \
                re.search(r'/(\d{4})-(\d{2})/(\d{2})/', href) or \
                re.search(r'/(\d{4})(\d{2})/(\d{2})/', href)
            if m:
                d = _validate_date(f'{m.group(1)}-{m.group(2)}-{m.group(3)}')
        # Also try span sibling for date
        if not d:
            parent = a.parent
            if parent:
                span = parent.find('span')
                if span:
                    d = _validate_date(_extract_date(span.get_text()))
        seen.add(title)
        items.append(_make_item(title, _abs_url(base_url, href), d, source_key))
    # Sort by date descending, take top 20
    items.sort(key=lambda x: x.get('date', ''), reverse=True)
    if not items:
        name = GOV_SOURCES.get(source_key, {}).get('name', source_key)
        return _fetch_search_news(name, source_key)
    result = items[:20]
    # Recover truncated titles (ending with ... or …) via og:title/h1
    for item in result:
        t = item.get('title', '')
        if t.endswith('...') or t.endswith('…'):
            try:
                r = _safe_get(item['url'], timeout=5, retries=0)
                if r and r.ok:
                    s = BeautifulSoup(r.text, 'html.parser')
                    og = s.find('meta', property='og:title')
                    full = (og['content'].strip() if og and og.get('content') else '') or \
                           (s.find('h1').get_text(strip=True) if s.find('h1') else '') or \
                           (s.find('title').get_text(strip=True) if s.find('title') else '')
                    if full and len(full) > len(t):
                        item['title'] = full
            except Exception:
                pass
    return result


def _fetch_mot():
    """交通运输部"""
    return _fetch_gov_generic('https://www.mot.gov.cn/', 'mot')


def _fetch_moa():
    """农业农村部"""
    return _fetch_gov_generic('http://www.moa.gov.cn/', 'moa')


def _fetch_most():
    """科技部 — homepage is JS-rendered, use /kjbgz/ (科技部工作) subpage."""
    return _fetch_gov_generic('https://www.most.gov.cn/kjbgz/index.html', 'most',
                              base_url='https://www.most.gov.cn/kjbgz/')


def _fetch_mee():
    """生态环境部"""
    return _fetch_gov_generic('https://www.mee.gov.cn/', 'mee')


def _fetch_mwr():
    """水利部"""
    return _fetch_gov_generic('http://www.mwr.gov.cn/', 'mwr')


def _fetch_mem():
    """应急管理部"""
    return _fetch_gov_generic('https://www.mem.gov.cn/', 'mem')


def _fetch_chinatax():
    """国家税务总局"""
    return _fetch_gov_generic('http://www.chinatax.gov.cn/', 'chinatax')


def _fetch_moe():
    """教育部"""
    return _fetch_gov_generic('http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/', 'moe',
                              base_url='http://www.moe.gov.cn')


def _fetch_mct():
    """文旅部"""
    return _fetch_gov_generic('https://www.mct.gov.cn/whzx/whyw/', 'mct',
                              base_url='https://www.mct.gov.cn')


def _fetch_mnr():
    """自然资源部"""
    return _fetch_gov_generic('https://www.mnr.gov.cn/dt/ywbb/', 'mnr',
                              base_url='https://www.mnr.gov.cn')


def _fetch_samr():
    """市场监管总局"""
    return _fetch_gov_generic('https://www.samr.gov.cn/xw/zj/', 'samr',
                              base_url='https://www.samr.gov.cn')


def _fetch_mva():
    """退役军人部"""
    return _fetch_gov_generic('https://www.mva.gov.cn/xinwen/ywdt/', 'mva',
                              base_url='https://www.mva.gov.cn')


def _fetch_nea():
    """国家能源局"""
    return _fetch_gov_generic('http://www.nea.gov.cn/xwzx/nyyw.htm', 'nea',
                              base_url='http://www.nea.gov.cn')


def _fetch_moj():
    """司法部"""
    return _fetch_gov_generic('http://www.moj.gov.cn/', 'moj')


def _fetch_mca():
    """民政部"""
    items = _fetch_gov_generic('https://www.mca.gov.cn/n152/n166/index.html', 'mca',
                               base_url='https://www.mca.gov.cn')
    if not items:
        items = _fetch_gov_generic('https://www.mca.gov.cn/', 'mca')
    return items


def _fetch_nhsa():
    """国家医保局"""
    return _fetch_gov_generic('http://www.nhsa.gov.cn/', 'nhsa')


def _fetch_miit():
    """工信部 — /zwgk/ (政务公开) is server-rendered with article links.
    Falls back to multi-keyword search if WAF blocks direct access."""
    resp = _safe_get('https://www.miit.gov.cn/zwgk/')
    if not resp or len(resp.text) < 5000:
        return _fetch_search_news_multi(
            ['工信部', '工业和信息化部 政策', '工信部 通信'],
            'miit', n=15)
    soup = BeautifulSoup(resp.text, 'html.parser')
    items, seen = [], set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True) or a.get('title', '')
        if len(title) < 8 or title in seen:
            continue
        href = a.get('href', '')
        if not href or href.startswith('javascript'):
            continue
        if '/art/' not in href:
            continue
        seen.add(title)
        d = ''
        # URL pattern: /art/2026/art_xxx.html
        m = re.search(r'/art/(\d{4})/art_', href)
        if m:
            d = m.group(1)
        # Try date from sibling span
        parent = a.parent
        if parent:
            span = parent.find('span')
            if span:
                d_text = _extract_date(span.get_text())
                if d_text:
                    d = d_text
        items.append(_make_item(title, _abs_url('https://www.miit.gov.cn', href), d, 'miit'))
    items.sort(key=lambda x: x.get('date', ''), reverse=True)
    if items:
        return items[:15]
    return _fetch_search_news_multi(
        ['工信部', '工业和信息化部 政策', '工信部 通信'],
        'miit', n=15)


def _fetch_mohurd():
    """住建部 — 建设要闻(JS渲染, 多URL尝试)"""
    for url in [
        'https://www.mohurd.gov.cn/xinwen/jsyw/',
        'https://www.mohurd.gov.cn/',
    ]:
        resp = _safe_get(url, encoding='utf-8')
        if not resp or len(resp.text) < 3000:
            continue
        soup = BeautifulSoup(resp.text, 'html.parser')
        items, seen = [], set()
        for a in soup.select('a[href]'):
            title = a.get_text(strip=True) or a.get('title', '')
            if len(title) < 8 or title in seen:
                continue
            href = a.get('href', '')
            if not href or not (href.endswith('.html') or href.endswith('.htm')):
                continue
            if '/index.' in href:
                continue
            seen.add(title)
            d = ''
            m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
            if m:
                d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
            else:
                m = re.search(r'/(\d{4})(\d{2})(\d{2})', href)
                if m:
                    d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
            items.append(_make_item(title, _abs_url('https://www.mohurd.gov.cn', href), d, 'mohurd'))
        if items:
            return items[:15]
    return _fetch_search_news('住建部', 'mohurd')


def _fetch_customs():
    """海关总署 — customs.gov.cn returns 412 WAF, use multi-keyword search."""
    return _fetch_search_news_multi(
        ['海关总署', '海关总署 公告', '海关 进出口数据'],
        'customs', n=15)


def _fetch_mfa():
    """外交部 — 外交部新闻"""
    resp = _safe_get('https://www.mfa.gov.cn/web/wjdt_674879/wjbxw_674885/', encoding='utf-8')
    if not resp:
        return _fetch_search_news('外交部', 'mfa')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items, seen = [], set()
    for li in soup.select('div.rili_text li, ul.rili_text li, li'):
        a = li.find('a')
        if not a:
            continue
        title = a.get_text(strip=True) or a.get('title', '')
        if len(title) < 6 or title in seen:
            continue
        href = a.get('href', '')
        if not href or href.startswith('javascript'):
            continue
        if not (href.endswith('.html') or href.endswith('.htm') or href.endswith('.shtml')):
            continue
        if '/index.' in href:
            continue
        seen.add(title)
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        else:
            m = re.search(r'/(\d{4})(\d{2})(\d{2})', href)
            if m:
                d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        span = li.find('span')
        if not d and span:
            d = _extract_date(span.get_text())
        items.append(_make_item(title, _abs_url('https://www.mfa.gov.cn/web/wjdt_674879/wjbxw_674885/', href), d, 'mfa'))
    return items[:15]


def _fetch_mohrss():
    """人社部 — mohrss.gov.cn is JS-rendered, use multi-keyword search."""
    return _fetch_search_news_multi(
        ['人社部', '人力资源和社会保障部 政策', '社保 新政策'],
        'mohrss', n=15)


def _fetch_sse():
    """上交所 — 媒体中心热点与动态"""
    resp = _safe_get('http://www.sse.com.cn/aboutus/mediacenter/hotandd/', encoding='utf-8')
    if not resp:
        return _fetch_search_news('上交所', 'sse')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items, seen = [], set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True) or a.get('title', '')
        if len(title) < 8 or title in seen:
            continue
        href = a.get('href', '')
        if not href:
            continue
        if not (href.endswith('.shtml') or href.endswith('.html') or href.endswith('.htm')):
            continue
        if '/index.' in href:
            continue
        # Skip nav-only links
        if href.startswith('../../') and 'doc' not in href:
            continue
        seen.add(title)
        d = ''
        m = re.search(r'/c/(\d{4})-(\d{2})-(\d{2})/', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        else:
            m = re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
            if m:
                d = f'{m.group(3)}-{m.group(4)}-{m.group(5)}'
        items.append(_make_item(title, _abs_url('http://www.sse.com.cn', href), d, 'sse'))
    return items[:15]


def _fetch_szse():
    """深交所 — 本所要闻(JS变量渲染, 用正则提取curHref/curTitle)"""
    for url in [
        'http://www.szse.cn/aboutus/trends/news/',
        'http://www.szse.cn/aboutus/trends/',
    ]:
        resp = _safe_get(url, encoding='utf-8')
        if not resp or len(resp.text) < 2000:
            continue
        html = resp.text
        # SZSE renders list via JS variables in inline script blocks
        hrefs = re.findall(r"var\s+curHref\s*=\s*'([^']+)'", html)
        titles = re.findall(r"var\s+curTitle\s*=\s*'([^']+)'", html)
        dates = re.findall(r'<span\s+class="time">\s*(\d{4}-\d{2}-\d{2})\s*</span>', html)
        if hrefs and titles:
            items, seen = [], set()
            for i in range(min(len(hrefs), len(titles))):
                title = titles[i].strip()
                if len(title) < 6 or title in seen:
                    continue
                seen.add(title)
                href = hrefs[i]
                d = dates[i] if i < len(dates) else ''
                items.append(_make_item(title, _abs_url('http://www.szse.cn/aboutus/trends/news/', href), d, 'szse'))
            if items:
                return items[:15]
    # Final fallback to generic
    return _fetch_gov_generic('http://www.szse.cn/aboutus/trends/news/', 'szse',
                              base_url='http://www.szse.cn/')


def _fetch_nhc():
    """卫健委 — nhc.gov.cn returns 412 WAF, use multi-keyword search."""
    return _fetch_search_news_multi(
        ['国家卫健委', '卫生健康委员会 通知', '卫健委 政策'],
        'nhc', n=15)


# ── 国资央企 fetchers ──────────────────────────────────────────────────────

def _fetch_sasac():
    """国资委 — sasac.gov.cn homepage + gov.cn cross-links."""
    return _fetch_gov_generic('http://www.sasac.gov.cn/', 'sasac')


# ── 外贸外交 fetchers ─────────────────────────────────────────────────────

def _fetch_mofcom():
    """商务部 — mofcom.gov.cn homepage news links."""
    resp = _safe_get('http://www.mofcom.gov.cn/')
    if not resp:
        return _fetch_search_news('商务部', 'mofcom')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if not (href.endswith('.html') or href.endswith('.htm') or href.endswith('.shtml')):
            continue
        if '/index.' in href:
            continue
        d = ''
        m = re.search(r'/(\d{4})(\d{2})/(\d{2})/', href) or \
            re.search(r'/(\d{4})(\d{2})/t(\d{4})(\d{2})(\d{2})_', href)
        if m:
            groups = m.groups()
            if len(groups) == 5:
                d = f'{groups[2]}-{groups[3]}-{groups[4]}'
            elif len(groups) == 3:
                d = f'{groups[0]}-{groups[1]}-{groups[2]}'
        url = _abs_url('http://www.mofcom.gov.cn', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, d, 'mofcom'))
    return items[:20]


def _fetch_safe():
    """国家外汇局 — safe.gov.cn homepage news."""
    resp = _safe_get('https://www.safe.gov.cn/')
    if not resp:
        return _fetch_search_news('国家外汇局', 'safe')
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 8:
            continue
        href = a.get('href', '')
        if not re.search(r'/\d{4}/\d{4}/', href):
            continue
        d = ''
        m = re.search(r'/(\d{4})/(\d{2})(\d{2})/', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        url = _abs_url('https://www.safe.gov.cn', href)
        if title not in seen:
            seen.add(title)
            items.append(_make_item(title, url, d, 'safe'))
    return items[:15]


# ── 国际央行 fetchers ─────────────────────────────────────────────────────

def _fetch_fed():
    """美联储 — RSS press releases (all)."""
    resp = _safe_get_intl('https://www.federalreserve.gov/feeds/press_all.xml')
    if not resp:
        return []
    return _parse_rss_items(resp.text, 'fed', max_items=20)


def _fetch_ecb():
    """欧央行 — RSS press releases."""
    resp = _safe_get_intl('https://www.ecb.europa.eu/rss/press.xml')
    if not resp:
        return []
    return _parse_rss_items(resp.text, 'ecb', max_items=15)


def _fetch_boj():
    """日本央行 — English homepage #newsList (panels with speeches, policy, stats)."""
    resp = _safe_get_intl('https://www.boj.or.jp/en/')
    if not resp:
        return []
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    # Parse the #newsList section which has panels with real news
    news_list = soup.select_one('#newsList')
    container = news_list if news_list else soup
    for a in container.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 15 or title in seen:
            continue
        href = a.get('href', '')
        # Skip PDFs, XLS, index pages, navigation
        if any(href.endswith(ext) for ext in ['.pdf', '.xlsx', '.xls', '.csv']):
            continue
        if not (href.endswith('.htm') or href.endswith('.html')):
            continue
        if '/index.' in href or '/sitemap' in href:
            continue
        # Only BOJ content paths
        if not ('/en/' in href or href.startswith('/en/')):
            continue
        seen.add(title)
        d = ''
        # Date from URL: /2026/ac260310.htm → 2026-03-10
        m = re.search(r'/(\d{4})/\w*(\d{2})(\d{2})\w*\.htm', href)
        if m:
            d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        else:
            # Try /ko260303a.htm pattern → 2026-03-03
            m2 = re.search(r'/\w+(\d{2})(\d{2})(\d{2})\w*\.htm', href)
            if m2:
                yy, mm, dd = m2.group(1), m2.group(2), m2.group(3)
                d = f'20{yy}-{mm}-{dd}'
        url = _abs_url('https://www.boj.or.jp', href)
        items.append(_make_item(title, url, d, 'boj'))
    return items[:20]


def _fetch_boe():
    """英国央行 — RSS news feed."""
    resp = _safe_get_intl('https://www.bankofengland.co.uk/rss/news')
    if not resp:
        return []
    return _parse_rss_items(resp.text, 'boe', max_items=15)


# ── 国际机构 fetchers ─────────────────────────────────────────────────────

def _fetch_imf():
    """IMF — news page. JS-rendered so try RSS first."""
    from datetime import date as _date
    today_str = _date.today().isoformat()
    # Try IMF RSS feed
    resp = _safe_get_intl('https://www.imf.org/en/News/RSS')
    if resp and resp.headers.get('content-type', '').startswith('text/xml'):
        items = _parse_rss_items(resp.text, 'imf', max_items=15)
        if items:
            return [i for i in items if i.get('date', '') <= today_str]
    # Fallback to HTML scraping
    resp = _safe_get_intl('https://www.imf.org/en/News')
    if not resp:
        return []
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href]'):
        title = a.get_text(strip=True)
        if len(title) < 15 or title in seen:
            continue
        href = a.get('href', '')
        # Only article-like paths with dates
        m = re.search(r'/News/Articles/(\d{4})/(\d{2})/(\d{2})/', href, re.IGNORECASE)
        if not m:
            m = re.search(r'/news/press-release/(\d{4})/(\d{2})/(\d{2})/', href, re.IGNORECASE)
        if not m:
            continue
        d = f'{m.group(1)}-{m.group(2)}-{m.group(3)}'
        if d > today_str:
            continue  # Skip future-dated articles
        seen.add(title)
        url = _abs_url('https://www.imf.org', href)
        items.append(_make_item(title, url, d, 'imf'))
    return items[:15]


def _fetch_bis():
    """BIS — RSS press releases (RDF 1.0 format)."""
    resp = _safe_get_intl('https://www.bis.org/doclist/all_pressrels.rss')
    if not resp:
        return []
    items = []
    try:
        root = ET.fromstring(resp.text)
        # RDF RSS 1.0: <item rdf:about="..."><title>...<link>...<dc:date>...
        ns_dc = 'http://purl.org/dc/elements/1.1/'
        ns_rss = 'http://purl.org/rss/1.0/'
        # Try with namespace
        for item_el in root.iter(f'{{{ns_rss}}}item'):
            title_el = item_el.find(f'{{{ns_rss}}}title')
            link_el = item_el.find(f'{{{ns_rss}}}link')
            date_el = item_el.find(f'{{{ns_dc}}}date')
            if title_el is None or not (title_el.text or '').strip():
                continue
            title = title_el.text.strip()
            link = (link_el.text or '').strip() if link_el is not None else ''
            if not link:
                link = item_el.get('{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about', '')
            d = _parse_rss_date(date_el.text if date_el is not None else '')
            items.append(_make_item(title, link, d, 'bis'))
            if len(items) >= 15:
                break
        # Fallback: try without namespace
        if not items:
            for item_el in root.iter('item'):
                title_el = item_el.find('title')
                link_el = item_el.find('link')
                date_el = item_el.find(f'{{{ns_dc}}}date') or item_el.find('pubDate')
                if title_el is None or not (title_el.text or '').strip():
                    continue
                title = title_el.text.strip()
                link = (link_el.text or '').strip() if link_el is not None else ''
                d = _parse_rss_date(date_el.text if date_el is not None else '')
                items.append(_make_item(title, link, d, 'bis'))
                if len(items) >= 15:
                    break
    except ET.ParseError as e:
        logger.warning(f'BIS RSS parse error: {e}')
    return items


# ── 国际媒体 fetchers ────────────────────────────────────────────────────────

def _resolve_google_news_url(gnews_url):
    """Decode Google News article URL to get actual article URL.
    Google News RSS wraps articles in /rss/articles/CBMi... encoded URLs.
    Uses googlenewsdecoder library to decode the protobuf-encoded URL.
    Note: Do NOT set HTTPS_PROXY — the library works faster without proxy (~1s vs ~20s)."""
    if 'news.google.com' not in gnews_url:
        return gnews_url
    try:
        from googlenewsdecoder import new_decoderv1
        result = new_decoderv1(gnews_url, interval=0)
        if result and result.get('status') and result.get('decoded_url'):
            return result['decoded_url']
    except Exception as e:
        logger.debug(f'Google News URL decode failed: {e}')
    return gnews_url


def _fetch_reuters():
    """Reuters — business/markets wire via Google News RSS.
    Reuters blocks direct access (401/404), so we use Google News RSS
    filtered for reuters.com as a reliable proxy.
    URLs are stored as Google News encoded URLs; decoded on-demand in
    article_fetcher.py when user requests content."""
    resp = _safe_get_intl(
        'https://news.google.com/rss/search?q=site:reuters.com+business+OR+markets&hl=en-US&gl=US&ceid=US:en')
    if resp and resp.ok and '<item>' in resp.text:
        items = _parse_rss_items(resp.text, 'reuters', max_items=15)
        if items:
            return items
    return []


def _fetch_cnbc():
    """CNBC — business/finance news. RSS primary."""
    resp = _safe_get_intl('https://www.cnbc.com/id/100003114/device/rss/rss.html')
    if resp and resp.ok:
        items = _parse_rss_items(resp.text, 'cnbc', max_items=15)
        if items:
            return items
    # HTML fallback
    resp = _safe_get_intl('https://www.cnbc.com/world/')
    if not resp:
        return []
    soup = BeautifulSoup(resp.text, 'html.parser')
    items = []
    seen = set()
    for a in soup.select('a[href*="/202"]'):
        href = a.get('href', '')
        title = a.get_text(strip=True)
        if len(title) < 15 or title in seen:
            continue
        seen.add(title)
        m = re.search(r'/(\d{4})/(\d{2})/(\d{2})/', href)
        d = _validate_date(f'{m.group(1)}-{m.group(2)}-{m.group(3)}') if m else date.today().isoformat()
        items.append(_make_item(title, href, d, 'cnbc'))
    return items[:15]


def _fetch_nikkei():
    """日経新聞 Nikkei Asia — business/finance via RSS feed."""
    resp = _safe_get_intl('https://asia.nikkei.com/rss/feed/nar')
    if resp and resp.ok:
        items = _parse_rss_items(resp.text, 'nikkei', max_items=15)
        if items:
            return items
    # Fallback: Google News RSS filtered for nikkei
    resp = _safe_get_intl(
        'https://news.google.com/rss/search?q=site:asia.nikkei.com&hl=en-US&gl=US&ceid=US:en')
    if resp and resp.ok and '<item>' in resp.text:
        items = _parse_rss_items(resp.text, 'nikkei', max_items=15)
        for item in items:
            m = re.search(r'url=(https?://[^&]+)', item.get('url', ''))
            if m:
                item['url'] = m.group(1)
        if items:
            return items
    return []


def _fetch_bloomberg():
    """Bloomberg — markets/finance via official RSS feed.
    feeds.bloomberg.com serves clean RSS 2.0 with 30 items, no auth needed."""
    resp = _safe_get_intl('https://feeds.bloomberg.com/markets/news.rss')
    if resp and resp.ok:
        items = _parse_rss_items(resp.text, 'bloomberg', max_items=15)
        if items:
            return items
    # Fallback: Google News RSS filtered for bloomberg.com
    resp = _safe_get_intl(
        'https://news.google.com/rss/search?q=site:bloomberg.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en')
    if resp and resp.ok and '<item>' in resp.text:
        items = _parse_rss_items(resp.text, 'bloomberg', max_items=15)
        if items:
            return items
    return []


# ── Dispatcher ───────────────────────────────────────────────────────────────

_FETCHERS = {
    # 领导活动
    'leaders': _fetch_leaders,
    'xinhua_leaders': _fetch_xinhua_leaders,
    'gov_premier': _fetch_gov_premier,
    'pbc_governor': _fetch_pbc_governor,
    'mof_minister': _fetch_mof_minister,
    'ndrc_chairman': _fetch_ndrc_chairman,
    'csrc_chairman': _fetch_csrc_chairman,
    'nfra_chairman': _fetch_nfra_chairman,
    'mofcom_minister': _fetch_mofcom_minister,
    'mfa_spokesman': _fetch_mfa_spokesman,
    'safe_director': _fetch_safe_director,
    'miit_minister': _fetch_miit_minister,
    'mohrss_minister': _fetch_mohrss_minister,
    'mohurd_minister': _fetch_mohurd_minister,
    'mot_minister': _fetch_mot_minister,
    'moa_minister': _fetch_moa_minister,
    'most_minister': _fetch_most_minister,
    'mee_minister': _fetch_mee_minister,
    'nhc_director': _fetch_nhc_director,
    'mem_minister': _fetch_mem_minister,
    'sasac_director': _fetch_sasac_director,
    # 央媒
    'people': _fetch_people,
    'xinhua': _fetch_xinhua,
    'cctv': _fetch_cctv,
    'ce': _fetch_ce,
    # 纪检监察
    'cpc': _fetch_cpc,
    'ccdi_inspect': _fetch_ccdi_inspect,
    # 审计
    'audit': _fetch_audit,
    # 财政货币
    'pbc': _fetch_pbc,
    'mof': _fetch_mof,
    'ndrc': _fetch_ndrc,
    # 金融监管
    'csrc': _fetch_csrc,
    'nfra': _fetch_nfra,
    'sse': _fetch_sse,
    'szse': _fetch_szse,
    # 国务院
    'gov': _fetch_gov,
    'gov_yaowen': _fetch_gov_yaowen,
    # 统计
    'stats': _fetch_stats,
    'customs': _fetch_customs,
    # 部委动态
    'miit': _fetch_miit,
    'mohurd': _fetch_mohurd,
    'mohrss': _fetch_mohrss,
    'nhc': _fetch_nhc,
    'mot': _fetch_mot,
    'moa': _fetch_moa,
    'most': _fetch_most,
    'mee': _fetch_mee,
    'mwr': _fetch_mwr,
    'mem': _fetch_mem,
    'chinatax': _fetch_chinatax,
    'moe': _fetch_moe,
    'mct': _fetch_mct,
    'mnr': _fetch_mnr,
    'samr': _fetch_samr,
    'mva': _fetch_mva,
    'nea': _fetch_nea,
    'moj': _fetch_moj,
    'mca': _fetch_mca,
    'nhsa': _fetch_nhsa,
    # 国资央企
    'sasac': _fetch_sasac,
    # 理论
    'qiushi': _fetch_qiushi,
    # 海外
    'people_overseas': _fetch_people_overseas,
    # 外贸外交
    'mfa': _fetch_mfa,
    'mofcom': _fetch_mofcom,
    'safe': _fetch_safe,
    # 财经媒体
    'caixin': _fetch_caixin,
    'yicai': _fetch_yicai,
    'stcn': _fetch_stcn,
    'cs': _fetch_cs,
    'cnstock': _fetch_cnstock,
    'jingji21': _fetch_jingji21,
    'nbd': _fetch_nbd,
    'jiemian': _fetch_jiemian,
    'jjckb': _fetch_jjckb,
    'eeo': _fetch_eeo,
    'thepaper': _fetch_thepaper,
    # 金融监管 (新增)
    'bse': _fetch_bse,
    # 智库
    'cssn': _fetch_cssn,
    'ciis': _fetch_ciis,
    # 国际央行
    'fed': _fetch_fed,
    'ecb': _fetch_ecb,
    'boj': _fetch_boj,
    'boe': _fetch_boe,
    # 国际机构
    'imf': _fetch_imf,
    'bis': _fetch_bis,
    # 国际媒体
    'reuters': _fetch_reuters,
    'cnbc': _fetch_cnbc,
    'nikkei': _fetch_nikkei,
    'bloomberg': _fetch_bloomberg,
}


def _record_health(key, count, error=None):
    """Record per-source health metrics to Redis."""
    try:
        from services.cache import cache_set
        from datetime import datetime
        data = {
            'count': count,
            'ts': datetime.now().isoformat(),
            'time': datetime.now().strftime('%H:%M:%S'),
        }
        if error:
            data['error'] = str(error)[:200]
        cache_set(f'cn:health:{key}', data, 86400)  # 24h TTL
    except Exception:
        pass


def _fetch_source(key):
    """Fetch a single source, return (key, items)."""
    fetcher = _FETCHERS.get(key)
    if not fetcher:
        return key, []
    try:
        items = fetcher()
        logger.warning(f'[gov] {key}: {len(items)} items')
        _record_health(key, len(items))
        return key, items
    except Exception as e:
        logger.warning(f'[gov] {key} failed: {e}')
        _record_health(key, 0, error=e)
        return key, []


def get_gov_news(categories=None):
    """Fetch all government news sources in parallel.

    Args:
        categories: optional list of category names to filter by

    Returns:
        dict with 'categories' (grouped by category), 'all' (flat list),
        'sources' (per-source counts), 'total', 'timestamp'
    """
    # Determine which sources to fetch
    if categories:
        source_keys = [k for k, v in GOV_SOURCES.items() if v['category'] in categories]
    else:
        source_keys = list(GOV_SOURCES.keys())

    raw_items = []
    source_counts = {}

    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = {executor.submit(_fetch_source, key): key for key in source_keys}
        try:
            for future in as_completed(futures, timeout=60):
                try:
                    key, items = future.result(timeout=12)
                    source_counts[key] = len(items)
                    raw_items.extend(items)
                except Exception as e:
                    key = futures[future]
                    logger.warning(f'[gov] {key} timeout/error: {e}')
                    source_counts[key] = 0
        except Exception as te:
            # as_completed raises TimeoutError when not all futures finish in time
            unfinished = [k for f, k in futures.items() if not f.done()]
            logger.warning(f'[gov] {len(unfinished)}/{len(futures)} sources timed out ({type(te).__name__}): {unfinished}')
            for f, k in futures.items():
                if k not in source_counts:
                    source_counts[k] = 0

    # Clean titles (same logic used in policy_store for MySQL)
    from services.policy_store import _clean_title
    for item in raw_items:
        item['title'] = _clean_title(item.get('title', ''))
        item['date'] = _validate_date(item.get('date', ''))

    # Filter 领导活动 items from search engines — must be about gov/party leaders
    _LEADER_KEYWORDS = (
        '国务院', '中央', '总书记', '总理', '主席', '部长', '局长', '主任',
        '书记', '省长', '市长', '部委', '发改委', '央行', '证监会', '银保监',
        '金监', '财政部', '商务部', '外交部', '工信部', '人社部', '住建部',
        '交通部', '农业', '科技部', '生态环境', '卫健委', '应急', '国资委',
        '人民银行', '外汇局', '政协', '人大', '纪委', '监委', '党委',
        '政府', '省委', '市委', '国家', '中共', '政治局', '常委',
        '习近平', '李强', '赵乐际', '王沪宁', '蔡奇', '丁薛祥', '韩正',
    )
    filtered_items = []
    for item in raw_items:
        # Only filter search-sourced items in 领导活动 category
        if item.get('category') == '领导活动' and item.get('via_search'):
            title = item.get('title', '')
            if not any(kw in title for kw in _LEADER_KEYWORDS):
                continue  # Drop irrelevant search result
        filtered_items.append(item)
    raw_items = filtered_items

    # Cross-source dedup by URL (same article from multiple sources)
    seen_urls = set()
    all_items = []
    by_category = {}
    for item in raw_items:
        url = item.get('url', '')
        if url in seen_urls:
            continue
        if not item.get('title', ''):
            continue
        seen_urls.add(url)
        all_items.append(item)
        cat = item.get('category', '其他')
        if cat not in by_category:
            by_category[cat] = []
        by_category[cat].append(item)

    # Sort each category by date descending
    for cat in by_category:
        by_category[cat].sort(key=lambda x: x.get('date', ''), reverse=True)

    # Sort all items
    all_items.sort(key=lambda x: x.get('date', ''), reverse=True)

    return {
        'categories': by_category,
        'all': all_items[:500],
        'sources': source_counts,
        'total': len(all_items),
        'category_list': GOV_CATEGORIES,
        'timestamp': datetime.now().isoformat(),
    }
