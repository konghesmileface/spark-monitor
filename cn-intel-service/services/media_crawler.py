"""Multi-platform social media sentiment system.
Fetches real data from public hot-list APIs (no login required).
Platforms: 微博热搜, 知乎热榜, 百度热搜, 头条热榜, 雪球热股, 东方财富人气榜, B站热搜, 小红书热搜."""

import logging
import re
import requests
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

logger = logging.getLogger('cn-intel.media')

_TIMEOUT = 8
_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

# Let eastmoney requests go through HTTP_PROXY (Clash) — cloud IP is blocked
_NO_PROXY = None

# Topic categories for classification
_TOPIC_KEYWORDS = {
    '股市': ['股', 'A股', '大盘', '涨停', '跌停', '基金', '券商', '北向', '指数', '沪深', '创业板', '科创'],
    '房地产': ['房', '楼市', '地产', '房价', '限购', '按揭', '首付', '烂尾'],
    '科技': ['AI', '芯片', '半导体', '算力', '大模型', '机器人', '5G', '量子', '自动驾驶'],
    '消费': ['消费', '零售', '电商', '直播', '品牌', '奢侈', '旅游'],
    '政策': ['政策', '央行', '财政', '监管', '两会', '国务院', '发改委', '降息', '降准'],
    '宏观': ['GDP', '通胀', 'CPI', 'PMI', '出口', '进口', '贸易', '汇率', '美联储'],
    '就业': ['就业', '失业', '裁员', '招聘', '考公', '考研', '薪资'],
    '教育': ['教育', '高考', '大学', '学区', '培训', '留学'],
    '医疗': ['医疗', '医药', '中药', '生物', '疫苗', '创新药', '医保'],
    '能源': ['新能源', '光伏', '锂电', '风电', '氢能', '充电桩', '电动车'],
}

# Platform demographic profiles
_PLATFORM_PROFILES = {
    'weibo': {'label': '全年龄段', 'age_group': '全年龄'},
    'zhihu': {'label': '高学历用户', 'age_group': '25-40'},
    'baidu': {'label': '大众搜索', 'age_group': '全年龄'},
    'toutiao': {'label': '下沉市场', 'age_group': '25-50'},
    'xueqiu': {'label': '财经投资者', 'age_group': '25-50'},
    'eastmoney': {'label': '散户投资者', 'age_group': '25-55'},
    'bilibili': {'label': '年轻人', 'age_group': '18-28'},
    # NewsNow-expanded: Social
    'douyin': {'label': '短视频用户', 'age_group': '18-45'},
    'tieba': {'label': '兴趣社区', 'age_group': '16-35'},
    'coolapk': {'label': '数码社区', 'age_group': '18-30'},
    'ifeng': {'label': '综合新闻', 'age_group': '25-50'},
    'tencent-hot': {'label': '大众新闻', 'age_group': '全年龄'},
    # NewsNow-expanded: Finance
    'cls': {'label': '财经快讯', 'age_group': '25-50'},
    'cls-depth': {'label': '财经深度', 'age_group': '25-50'},
    'wallstreetcn': {'label': '专业财经', 'age_group': '25-45'},
    'wallstreetcn-hot': {'label': '专业财经', 'age_group': '25-45'},
    'jin10': {'label': '财经快讯', 'age_group': '25-45'},
    'gelonghui': {'label': '港美股投资', 'age_group': '25-45'},
    'mktnews-flash': {'label': '市场快讯', 'age_group': '25-45'},
    # NewsNow-expanded: News
    'thepaper': {'label': '深度新闻', 'age_group': '25-45'},
    'cankaoxiaoxi': {'label': '参考消息', 'age_group': '25-55'},
    'zaobao': {'label': '国际视角', 'age_group': '25-50'},
    'sputniknewscn': {'label': '国际新闻', 'age_group': '25-50'},
    'kaopu': {'label': '综合新闻', 'age_group': '25-45'},
    # NewsNow-expanded: Tech
    '36kr': {'label': '创投圈', 'age_group': '22-40'},
    'ithome': {'label': '科技爱好者', 'age_group': '18-35'},
    'sspai': {'label': '数码极客', 'age_group': '20-35'},
    'juejin': {'label': '开发者社区', 'age_group': '20-35'},
    'v2ex-share': {'label': '极客社区', 'age_group': '20-40'},
    'chongbuluo-hot': {'label': '搜索极客', 'age_group': '20-35'},
}

# NewsNow source mapping: source_id → (platform_key, Chinese label)
# When NEWSNOW_BASE_URL is set, these sources are fetched via NewsNow API
NEWSNOW_SOURCES = {
    # Social (overlapping with existing direct fetchers)
    'weibo': ('weibo', '微博'),
    # 'zhihu' excluded: direct fetcher provides excerpt (question description)
    # 'baidu' excluded: direct fetcher provides excerpt (search description)

    'toutiao': ('toutiao', '头条'),
    'bilibili': ('bilibili', 'B站'),
    # Social (new)
    'douyin': ('douyin', '抖音'),
    # 'tieba' excluded: direct fetcher provides excerpt (topic description)
    'coolapk': ('coolapk', '酷安'),
    'ifeng': ('ifeng', '凤凰网'),
    'tencent-hot': ('tencent-hot', '腾讯新闻'),
    # Finance (new)
    'cls': ('cls', '财联社'),
    'cls-depth': ('cls-depth', '财联社深度'),
    'wallstreetcn': ('wallstreetcn', '华尔街见闻'),
    'wallstreetcn-hot': ('wallstreetcn-hot', '华尔街热门'),
    'jin10': ('jin10', '金十'),
    'gelonghui': ('gelonghui', '格隆汇'),
    'mktnews-flash': ('mktnews-flash', 'MKTNews'),
    # News
    'thepaper': ('thepaper', '澎湃新闻'),
    'cankaoxiaoxi': ('cankaoxiaoxi', '参考消息'),
    'zaobao': ('zaobao', '联合早报'),
    'sputniknewscn': ('sputniknewscn', '卫星通讯社'),
    'kaopu': ('kaopu', '靠谱新闻'),
    # Tech
    '36kr': ('36kr', '36氪'),
    'ithome': ('ithome', 'IT之家'),
    'sspai': ('sspai', '少数派'),
    'juejin': ('juejin', '掘金'),
    'v2ex-share': ('v2ex-share', 'V2EX'),
    'chongbuluo-hot': ('chongbuluo-hot', '虫部落'),
}

# Ordered platform list for consistent tab ordering
_PLATFORM_ORDER = [
    # Social (popular)
    'weibo', 'zhihu', 'baidu', 'toutiao', 'bilibili', 'douyin',
    'tieba', 'coolapk',
    # Finance
    'xueqiu', 'eastmoney', 'cls', 'cls-depth', 'wallstreetcn', 'wallstreetcn-hot',
    'jin10', 'gelonghui', 'mktnews-flash',
    # News
    'ifeng', 'tencent-hot', 'thepaper', 'cankaoxiaoxi', 'zaobao',
    'sputniknewscn', 'kaopu',
    # Tech
    '36kr', 'ithome', 'sspai', 'juejin', 'v2ex-share', 'chongbuluo-hot',
]


def _classify_topic(text):
    """Classify text into topic category using keywords."""
    text = text.lower() if text else ''
    scores = {}
    for category, keywords in _TOPIC_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw.lower() in text)
        if score > 0:
            scores[category] = score
    if scores:
        return max(scores, key=lambda k: scores[k])
    return '其他'


def _simple_sentiment(text):
    """Simple keyword-based sentiment analysis."""
    if not text:
        return '中性'
    positive = ['涨', '牛', '利好', '突破', '放量', '大涨', '暴涨', '反弹', '上涨',
                 '赚', '盈利', '红', '好', '增长', '超预期', '强势', '新高']
    negative = ['跌', '熊', '利空', '破位', '缩量', '暴跌', '崩', '恐慌', '下跌',
                 '亏', '割肉', '绿', '差', '下滑', '低于预期', '弱势', '新低']
    pos = sum(1 for w in positive if w in text)
    neg = sum(1 for w in negative if w in text)
    if pos > neg:
        return '正面'
    elif neg > pos:
        return '负面'
    return '中性'


_STOP_WORDS = frozenset([
    # 虚词/助词/代词
    '的', '了', '是', '在', '有', '和', '与', '被', '对', '为', '从', '到',
    '不', '也', '都', '就', '还', '这', '那', '么', '什么', '怎么', '如何',
    '我', '你', '他', '她', '它', '们', '自己', '今天', '昨天', '明天',
    '已经', '可以', '一个', '没有', '可能', '因为', '所以', '但是', '如果',
    '正在', '开始', '以上', '以下', '关于', '通过', '进行', '问题', '情况',
    '表示', '记者', '报道', '消息', '根据', '目前', '来源', '据悉',
    '之后', '之前', '之间', '虽然', '然而', '而且', '或者', '以及', '由于',
    '即使', '只要', '无论', '不仅', '而是', '还是', '而言', '来看', '来说',
    '这个', '那个', '哪些', '这些', '那些', '某些', '每个', '大家', '别人',
    # 数量词/量词
    '万亿', '百亿', '多个', '若干', '部分', '全部', '整体', '其中', '各种',
    '亿元', '万元', '万人', '多家', '多名', '多项', '一批', '大量', '少量',
    '左右', '以内', '以外', '超过', '达到', '约为', '接近', '高达', '低至',
    # 时间词
    '未来', '过去', '最近', '近期', '当前', '本周', '本月', '今年', '去年',
    '上半年', '下半年', '上年', '同期', '季度', '月份', '年度', '年初', '年底',
    '日前', '日内', '周内', '近日', '此前', '此后', '随后', '同时', '期间',
    # 程度副词
    '非常', '很大', '较大', '比较', '相对', '一定', '显著', '明显', '大幅',
    '进一步', '将会', '预计', '约为', '或将', '有望', '可望', '料将',
    # 新闻套话/动词
    '指出', '认为', '表明', '显示', '发现', '实现', '推动', '促进', '提升', '加强',
    '持续', '不断', '积极', '深入', '有效', '重要', '全面', '着力', '落实',
    '加快', '完善', '优化', '强化', '保障', '支持', '鼓励', '引导', '推进',
    '开展', '实施', '建设', '创新', '稳定', '调整', '改革', '扩大', '提高',
    '下降', '上升', '同比', '环比', '增速', '涨幅', '跌幅', '增幅', '降幅',
    '发布', '公布', '宣布', '召开', '举行', '参加', '要求', '强调', '提出',
    '分析', '研究', '评估', '预测', '判断', '关注', '观察', '跟踪', '监测',
    # 财经通用（太泛泛）
    '市场', '公司', '企业', '行业', '经济', '发展', '增长', '投资', '基金',
    '板块', '股票', '数据', '政策', '方面', '领域', '体系', '机制', '模式',
    '水平', '能力', '效率', '质量', '规模', '趋势', '方向', '重点', '核心',
    '目标', '任务', '措施', '方案', '计划', '项目', '工作', '服务', '管理',
    '中国', '全球', '国内', '国际', '国家', '地区', '世界', '社会', '人民',
    # 新闻数据碎片词
    '前值', '预期', '公布值', '初值', '终值', '修正值', '季调',
    # 媒体源名（不应出现在词云）
    '财联社', '券商中国', '华尔街见闻', '第一财经', '证券时报', '金十数据',
    '格隆汇', '澎湃新闻', '参考消息', '央视财经', '新华社', '中新网',
    '每日经济新闻', '经济观察报', '21世纪经济', '界面新闻', '凤凰网',
    '36氪', 'IT之家', '少数派', '腾讯新闻', '网易新闻', '搜狐财经',
    '东方财富', '雪球', '同花顺', '新浪财经', '和讯网',
    '联合早报', '卫星通讯社', '环球时报', '观察者网', '财新',
    '市值风云', '资本秘闻', '债券民工', '债券人', '汇观卓见',
    # 数据碎片/jieba误切
    '日电', '月核', '月核心', '小时', '百分点', '百分比', '个月',
    '第一', '第二', '第三', '第四', '上年同期', '去年同期',
    '美国第四', '美国第三', '美国第二', '美国第一',
    '万亿元', '千亿', '十亿', '数十', '数百', '几十', '几百',
    '报告期', '报告', '指标', '指数', '点位', '基点', '个百分点',
    '上市', '上市公司', '股东', '股价', '股份', 'A股', 'A 股',
    # 国家名单独出现太泛
    '美国', '日本', '韩国', '英国', '法国', '德国', '俄罗斯', '印度',
    '欧洲', '亚洲', '北美', '东南亚',
])

_POSITIVE_WORDS = frozenset(['涨', '牛', '利好', '突破', '放量', '大涨', '反弹',
    '上涨', '赚', '盈利', '增长', '超预期', '强势', '新高', '暴涨', '红'])
_NEGATIVE_WORDS = frozenset(['跌', '熊', '利空', '破位', '缩量', '暴跌', '崩',
    '恐慌', '下跌', '亏', '割肉', '下滑', '低于预期', '弱势', '新低', '绿'])


def _is_meaningful_keyword(w):
    """Check if a keyword is meaningful (not a fragment or noise)."""
    if len(w) < 2:
        return False
    if w in _STOP_WORDS:
        return False
    # Must contain at least one Chinese character
    if not re.search(r'[\u4e00-\u9fff]', w):
        return False
    # Skip purely numeric or single-char-plus-number patterns like "2月", "3日"
    if re.match(r'^[\d.]+[月日年号期季届]?$', w):
        return False
    # Skip patterns like "X月核心", "第X季度"
    if re.match(r'^[\d]+月', w):
        return False
    return True


def _extract_keywords(posts, top_n=25):
    """Extract keywords from posts using jieba TF-IDF (much better than raw frequency)."""
    import jieba.analyse
    all_text = ' '.join(p.get('content', '') for p in posts)
    try:
        # TF-IDF automatically identifies important terms, not just frequent ones
        tags = jieba.analyse.extract_tags(all_text, topK=top_n * 3, withWeight=True)
        filtered = [(w, round(score * 100)) for w, score in tags
                     if _is_meaningful_keyword(w)]
        result = [{'word': w, 'count': max(1, s)} for w, s in filtered[:top_n]]
        if result:
            return result
    except Exception as e:
        logger.warning(f'jieba TF-IDF failed: {e}')
    # Fallback to regex frequency
    tokens = re.findall(r'[\u4e00-\u9fff]{2,6}', all_text)
    filtered = [t for t in tokens if _is_meaningful_keyword(t)]
    counts = Counter(filtered).most_common(top_n)
    return [{'word': word, 'count': count} for word, count in counts]


def _calc_sentiment_trend(distribution):
    """Return sentiment trend from real Redis history only. No PRNG fallback."""
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            import json as _json
            items = r.zrangebyscore('cn:sentiment:history', '-inf', '+inf')
            data = []
            seen = {}
            for item in (items or []):
                try:
                    d = _json.loads(item)
                    seen[d['date']] = d
                except Exception:
                    continue
            data = sorted(seen.values(), key=lambda x: x['date'])[-7:]
            if len(data) >= 2:
                diff = data[-1]['score'] - data[-2]['score']
                direction = 'improving' if diff > 3 else ('worsening' if diff < -3 else 'stable')
            else:
                direction = 'stable'
            return {'direction': direction, 'data': data}
    except Exception:
        pass
    return {'direction': 'stable', 'data': []}


def _platform_breakdown(platforms):
    """Calculate per-platform sentiment counts."""
    breakdown = {}
    for pname, posts in platforms.items():
        pos = sum(1 for p in posts if p.get('sentiment') == '正面')
        neg = sum(1 for p in posts if p.get('sentiment') == '负面')
        neu = len(posts) - pos - neg
        breakdown[pname] = {'pos': pos, 'neg': neg, 'neu': neu, 'total': len(posts)}
    return breakdown


# Module-level memory cache for NewsNow per-source data (fallback when Redis unavailable)
_newsnow_mem_cache = {}  # source_id → (data, expire_ts)
_NEWSNOW_CACHE_TTL = 900  # 15 minutes


def _newsnow_cache_get(source_id):
    """Get cached NewsNow data from Redis, fallback to memory."""
    import time
    # Try Redis
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            import json
            val = r.get(f'cn:newsnow:{source_id}')
            if val:
                return json.loads(val)
    except Exception:
        pass
    # Fallback to memory
    entry = _newsnow_mem_cache.get(source_id)
    if entry and entry[1] > time.time():
        return entry[0]
    return None


def _newsnow_cache_set(source_id, data):
    """Cache NewsNow data to Redis + memory."""
    import time
    _newsnow_mem_cache[source_id] = (data, time.time() + _NEWSNOW_CACHE_TTL)
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            import json
            r.setex(f'cn:newsnow:{source_id}', _NEWSNOW_CACHE_TTL,
                     json.dumps(data, ensure_ascii=False, default=str))
    except Exception:
        pass


def _get_newsnow_data(base_url, source_id):
    """Fetch hot list data from a NewsNow instance.
    API: GET {base_url}/api/s?id={source_id}
    Response: {status, id, updatedTime, items: [{title, url, extra?}]}
    On failure, retries once with shorter timeout, then falls back to cache.
    """
    label = NEWSNOW_SOURCES.get(source_id, (source_id, source_id))[1]

    def _do_fetch(timeout):
        resp = requests.get(
            f'{base_url}/api/s',
            params={'id': source_id},
            timeout=timeout,
            proxies=_NO_PROXY,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
        items = data.get('items') or data.get('data') or []
        posts = []
        for item in items[:20]:
            title = item.get('title', '')
            if not title:
                continue
            # Strip HTML tags (e.g. <b>...</b>) from titles
            title = re.sub(r'<[^>]+>', '', title).strip()
            engagement = 0
            extra = item.get('extra')
            if isinstance(extra, dict):
                info = str(extra.get('info', ''))
                if info:
                    nums = re.findall(r'[\d.]+', info)
                    if nums:
                        engagement = int(float(nums[0]))
                        if '万' in info:
                            engagement *= 10000
                        elif '亿' in info:
                            engagement *= 100000000
            posts.append({
                'content': title,
                'engagement': engagement,
                'author': label,
                'time': 'now',
                'url': item.get('url', ''),
            })
        return posts

    # First attempt
    try:
        posts = _do_fetch(_TIMEOUT)
        if posts:
            _newsnow_cache_set(source_id, posts)
            return posts
    except Exception:
        pass

    # Retry once with shorter timeout
    try:
        posts = _do_fetch(5)
        if posts:
            _newsnow_cache_set(source_id, posts)
            return posts
    except Exception as e:
        logger.warning(f'NewsNow {source_id} failed after retry: {e}')

    # Fallback to cache
    cached = _newsnow_cache_get(source_id)
    if cached:
        logger.warning(f'NewsNow {source_id} using cached data')
        return cached
    return []


def get_social_mood():
    """Get social media sentiment data from multiple real platforms.
    When NEWSNOW_BASE_URL is configured, expands to 35+ platforms via NewsNow API.
    Existing direct fetchers are kept as fallback for core 7 platforms."""
    from config import Config
    newsnow_url = Config.NEWSNOW_BASE_URL

    all_platforms = {}
    all_posts = []

    # Direct fetchers (always available as fallback)
    direct_fetchers = {
        'weibo': _get_weibo_hot,
        'zhihu': _get_zhihu_hot,
        'baidu': _get_baidu_hot,
        'toutiao': _get_toutiao_hot,
        'tieba': _get_tieba_hot,
        'xueqiu': _get_xueqiu_hot,
        'eastmoney': _get_eastmoney_hot,
        'bilibili': _get_bilibili_hot,
        'xiaohongshu': _get_xiaohongshu_hot,
        # Finance
        'wallstreetcn': _get_wallstreetcn_hot,
        'jin10': _get_jin10_hot,
        # News
        'thepaper': _get_thepaper_hot,
        # Tech
        '36kr': _get_36kr_hot,
        'ithome': _get_ithome_hot,
    }

    fetched = set()

    # If NewsNow is available, fetch all sources in parallel (10 concurrent, 20s total timeout)
    if newsnow_url:
        source_items = list(NEWSNOW_SOURCES.items())
        with ThreadPoolExecutor(max_workers=10) as executor:
            future_to_source = {
                executor.submit(_get_newsnow_data, newsnow_url, source_id): (source_id, platform_key)
                for source_id, (platform_key, label) in source_items
            }
            try:
                for future in as_completed(future_to_source, timeout=20):
                    source_id, platform_key = future_to_source[future]
                    try:
                        posts = future.result()
                        if posts:
                            all_platforms[platform_key] = posts
                            fetched.add(platform_key)
                    except Exception as e:
                        logger.warning(f'NewsNow {source_id} future failed: {e}')
            except TimeoutError:
                logger.warning('NewsNow parallel fetch hit 20s total timeout')

    # Fill in with direct fetchers (fallback for overlapping platforms, primary for eastmoney)
    for platform_key, fetcher in direct_fetchers.items():
        if platform_key in fetched:
            continue
        try:
            posts = fetcher()
            all_platforms[platform_key] = posts
            fetched.add(platform_key)
        except Exception as e:
            logger.warning(f'Failed to fetch {platform_key}: {e}')
            all_platforms[platform_key] = []

    # Sort platforms by defined order for consistent tab display
    ordered = {}
    for key in _PLATFORM_ORDER:
        if key in all_platforms:
            ordered[key] = all_platforms[key]
    # Append any platforms not in the order list
    for key in all_platforms:
        if key not in ordered:
            ordered[key] = all_platforms[key]
    all_platforms = ordered

    # Import entity extraction from hot_events
    try:
        from services.hot_events import _extract_related_stocks
    except ImportError:
        _extract_related_stocks = None

    # Add metadata to each post
    for platform, posts in all_platforms.items():
        profile = _PLATFORM_PROFILES.get(platform, {})
        for i, p in enumerate(posts):
            p['id'] = f'{platform}_{i}'
            p['platform'] = platform
            if 'sentiment' not in p:
                p['sentiment'] = _simple_sentiment(p.get('content', ''))
            if 'category' not in p:
                p['category'] = _classify_topic(p.get('content', ''))
            p['age_group'] = profile.get('age_group', '全年龄')
            # Entity extraction: tag stock mentions per post
            if _extract_related_stocks and 'mentions' not in p:
                mentions = _extract_related_stocks(p.get('content', ''))
                if mentions:
                    p['mentions'] = mentions
        all_posts.extend(posts)

    # Calculate sentiment distribution
    total = len(all_posts) or 1
    positive = sum(1 for p in all_posts if p.get('sentiment') == '正面')
    negative = sum(1 for p in all_posts if p.get('sentiment') == '负面')
    neutral = total - positive - negative

    # Category distribution
    categories = {}
    for p in all_posts:
        cat = p.get('category', '其他')
        if cat not in categories:
            categories[cat] = {'positive': 0, 'negative': 0, 'neutral': 0, 'total': 0}
        categories[cat]['total'] += 1
        if p.get('sentiment') == '正面':
            categories[cat]['positive'] += 1
        elif p.get('sentiment') == '负面':
            categories[cat]['negative'] += 1
        else:
            categories[cat]['neutral'] += 1

    distribution = {
        'positive': round(positive / total * 100),
        'negative': round(negative / total * 100),
        'neutral': round(neutral / total * 100),
    }

    return {
        # Legacy format (3 platforms for backward compatibility)
        'weibo': all_platforms.get('weibo', []),
        'zhihu': all_platforms.get('zhihu', []),
        'xiaohongshu': all_platforms.get('xiaohongshu', []),
        # New multi-platform format
        'platforms': all_platforms,
        'distribution': distribution,
        'categories': categories,
        # New: keywords, trend, platform breakdown
        'keywords': _extract_keywords(all_posts),
        'trend': _calc_sentiment_trend(distribution),
        'platformBreakdown': _platform_breakdown(all_platforms),
        'timestamp': datetime.now().isoformat()
    }


def get_entity_sentiment(entity_name=None, top_n=20):
    """Aggregate sentiment per stock entity from social media posts.
    If entity_name is given, return sentiment for that entity only.
    Otherwise, return top_n most-mentioned entities with sentiment breakdown."""
    from services.cache import cache_get

    cached_mood = cache_get('cn:mood:social')
    if not cached_mood:
        return {'entities': [], 'timestamp': datetime.now().isoformat()}

    # Collect all posts across platforms
    all_posts = []
    platforms = cached_mood.get('platforms', {})
    for posts in platforms.values():
        all_posts.extend(posts)

    # Aggregate per entity
    entity_stats = {}  # entity_name → {code, positive, negative, neutral, total, posts}
    for post in all_posts:
        mentions = post.get('mentions', [])
        if not mentions:
            continue
        sentiment = post.get('sentiment', '中性')
        for m in mentions:
            name = m.get('name', '')
            if not name:
                continue
            if entity_name and name != entity_name:
                continue
            if name not in entity_stats:
                entity_stats[name] = {
                    'name': name,
                    'code': m.get('code', ''),
                    'positive': 0, 'negative': 0, 'neutral': 0, 'total': 0,
                    'sample_posts': [],
                }
            stats = entity_stats[name]
            stats['total'] += 1
            if sentiment == '正面':
                stats['positive'] += 1
            elif sentiment == '负面':
                stats['negative'] += 1
            else:
                stats['neutral'] += 1
            if len(stats['sample_posts']) < 3:
                stats['sample_posts'].append(post.get('content', '')[:80])

    # Sort by total mentions
    entities = sorted(entity_stats.values(), key=lambda x: x['total'], reverse=True)[:top_n]

    # Calculate sentiment score per entity
    for e in entities:
        total = e['total'] or 1
        e['sentimentScore'] = round((e['positive'] - e['negative']) / total * 100)
        if e['sentimentScore'] > 20:
            e['sentimentLabel'] = '正面'
        elif e['sentimentScore'] < -20:
            e['sentimentLabel'] = '负面'
        else:
            e['sentimentLabel'] = '中性'

    return {
        'entities': entities,
        'total_posts_analyzed': len(all_posts),
        'timestamp': datetime.now().isoformat(),
    }


def get_mood_categories():
    """Get mood data organized by topic categories."""
    mood = get_social_mood()
    cats = mood.get('categories', {})
    # Add 'count' alias and 'sentiment' sub-dict for frontend compatibility
    formatted = {}
    for cat, info in cats.items():
        formatted[cat] = {
            'count': info.get('total', 0),
            'sentiment': {
                'positive': info.get('positive', 0),
                'negative': info.get('negative', 0),
                'neutral': info.get('neutral', 0),
            }
        }
    return {
        'categories': formatted,
        'distribution': mood.get('distribution', {}),
        'timestamp': mood.get('timestamp', datetime.now().isoformat()),
    }


def get_mood_regional():
    """Get mood data organized by region (province).
    Uses Weibo hot search topics with province estimation."""
    # Regional sentiment is handled by sentiment_geo.py
    # This provides a simple aggregation for the mood API
    return {
        'message': 'Use /api/cn/sentiment/regional for province-level data',
        'timestamp': datetime.now().isoformat(),
    }


# ============ Platform-specific fetchers ============

def _get_weibo_hot():
    """Fetch Weibo hot search (微博热搜)."""
    posts = []
    try:
        resp = requests.get(
            'https://weibo.com/ajax/side/hotSearch',
            headers={
                'User-Agent': _UA,
                'Referer': 'https://weibo.com/',
            },
            timeout=_TIMEOUT,
        )
        data = resp.json()
        realtime = data.get('data', {}).get('realtime', [])
        for item in realtime[:15]:
            word = item.get('word', '')
            label = item.get('label_name', '')
            num = item.get('num', 0)
            posts.append({
                'content': f'{word}' + (f' [{label}]' if label else ''),
                'engagement': num,
                'author': '微博热搜',
                'time': 'now',
                'url': f'https://s.weibo.com/weibo?q=%23{word}%23',
            })
    except Exception as e:
        logger.warning(f'Weibo hot search failed: {e}')
    return posts


def _get_zhihu_hot():
    """Fetch Zhihu hot list (知乎热榜) via mobile API.
    Returns title + excerpt (question description) + hot score."""
    posts = []
    try:
        resp = requests.get(
            'https://api.zhihu.com/topstory/hot-list?limit=20',
            headers={
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) '
                              'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 '
                              'Mobile/15E148 Safari/604.1',
                'Accept': 'application/json',
            },
            timeout=10,
            verify=False,
            proxies=_NO_PROXY,
        )
        if resp.status_code != 200:
            logger.warning(f'Zhihu API returned {resp.status_code}')
            return posts
        data = resp.json()
        for item in data.get('data', [])[:15]:
            target = item.get('target', {})
            title = target.get('title', '')
            if not title:
                continue
            qid = target.get('id', '')
            excerpt = target.get('excerpt', '')
            # Parse hot score from detail_text like "1079 万热度"
            detail = item.get('detail_text', '')
            engagement = 0
            if detail:
                import re as _re
                m = _re.search(r'(\d+)\s*万', detail)
                if m:
                    engagement = int(m.group(1)) * 10000
            posts.append({
                'content': title,
                'excerpt': excerpt,
                'engagement': engagement,
                'author': '知乎热榜',
                'time': 'now',
                'url': f'https://www.zhihu.com/question/{qid}' if qid else '',
            })
    except Exception as e:
        logger.warning(f'Zhihu hot list failed: {e}')
    return posts


def _get_baidu_hot():
    """Fetch Baidu hot search (百度热搜) via HTML page parsing.
    The JSON API is unreliable, but the HTML page contains all data."""
    import re as _re
    posts = []
    try:
        resp = requests.get(
            'https://top.baidu.com/board?tab=realtime',
            headers={
                'User-Agent': _UA,
                'Accept': 'text/html',
                'Referer': 'https://top.baidu.com/',
            },
            timeout=10,
        )
        if resp.status_code != 200:
            logger.warning(f'Baidu board page returned {resp.status_code}')
            return posts
        # Extract {word, desc, hotScore} from embedded JSON in HTML
        pattern = r'"word":"(.*?)".*?"desc":"(.*?)".*?"hotScore":"?(\d+)"?'
        found = _re.findall(pattern, resp.text[:250000])
        for word, desc, hot_score in found[:15]:
            if not word:
                continue
            content = word + (f' — {desc[:60]}' if desc else '')
            posts.append({
                'content': content,
                'excerpt': desc if desc else '',
                'engagement': int(hot_score),
                'author': '百度热搜',
                'time': 'now',
                'url': f'https://www.baidu.com/s?wd={word}',
            })
    except Exception as e:
        logger.warning(f'Baidu hot search failed: {e}')
    return posts


def _get_toutiao_hot():
    """Fetch Toutiao/Jinritoutiao hot list (头条热榜).
    Note: Toutiao content APIs require auth — only titles + engagement available."""
    posts = []
    try:
        resp = requests.get(
            'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
            headers={
                'User-Agent': _UA,
                'Referer': 'https://www.toutiao.com/',
            },
            timeout=_TIMEOUT,
        )
        data = resp.json()
        for item in data.get('data', [])[:15]:
            title = item.get('Title', '')
            hot_value = int(item.get('HotValue', 0))
            label = item.get('Label', '')
            posts.append({
                'content': title,
                'excerpt': f'热度 {hot_value:,}' + (f' · {label}' if label else ''),
                'engagement': hot_value,
                'author': '头条热榜',
                'time': 'now',
                'url': item.get('Url', ''),
            })
    except Exception as e:
        logger.warning(f'Toutiao hot list failed: {e}')
    return posts


def _get_xueqiu_hot():
    """Fetch Xueqiu-style financial discussion content (雪球/财经热议).
    Primary: Sina Finance rolling news (reliable, has fetchable article URLs).
    Fallback: Xueqiu hot stocks API (stock tickers only, requires WAF cookies)."""
    posts = []

    # Primary: Sina Finance rolling news — real article titles with fetchable URLs
    try:
        resp = requests.get(
            'https://feed.mix.sina.com.cn/api/roll/get',
            params={'pageid': '153', 'lid': '2516', 'num': '15', 'page': '1'},
            headers={'User-Agent': _UA},
            timeout=_TIMEOUT,
        )
        data = resp.json()
        items = data.get('result', {}).get('data', [])
        for item in items[:15]:
            title = item.get('title', '')
            if not title:
                continue
            intro = item.get('intro', '') or item.get('summary', '') or ''
            posts.append({
                'content': title,
                'excerpt': intro[:120] if intro else '',
                'engagement': int(item.get('hits', 0) or 0),
                'author': '财经热议',
                'time': 'now',
                'url': item.get('url', ''),
            })
        if posts:
            logger.warning(f'Xueqiu/Sina finance OK: {len(posts)} news articles')
    except Exception as e:
        logger.warning(f'Sina finance primary failed: {e}')

    # Fallback: Xueqiu hot stocks (may fail due to WAF)
    if not posts:
        try:
            sess = requests.Session()
            sess.headers.update({
                'User-Agent': _UA,
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://xueqiu.com/',
            })
            # Get session cookies first
            sess.get('https://xueqiu.com/', timeout=8)
            resp = sess.get(
                'https://stock.xueqiu.com/v5/stock/hot_stock/list.json',
                params={'size': '15', 'type': 'hot_discuss', '_type': 'volatile'},
                timeout=_TIMEOUT,
            )
            data = resp.json()
            items = data.get('data', {}).get('items', [])
            for item in items[:15]:
                name = item.get('name', '') or item.get('code', '')
                code = item.get('code', '')
                percent = item.get('percent', 0)
                value = int(item.get('value', 0) or 0)
                content = name if name else code
                if code and name != code:
                    content = f'{name}({code})'
                # Add price change for context
                excerpt = ''
                if percent:
                    sign = '+' if percent > 0 else ''
                    excerpt = f'涨跌 {sign}{percent:.2f}%'
                posts.append({
                    'content': content,
                    'excerpt': excerpt,
                    'engagement': value,
                    'author': '雪球热议',
                    'time': 'now',
                    'url': f'https://xueqiu.com/S/{code}' if code else 'https://xueqiu.com/',
                })
            if posts:
                logger.warning(f'Xueqiu hot stocks fallback OK: {len(posts)} stocks')
        except Exception as e2:
            logger.warning(f'Xueqiu hot stocks fallback also failed: {e2}')
    return posts


def _get_eastmoney_hot():
    """Fetch EastMoney hot financial news/discussion (东方财富舆情).
    Tries multiple APIs to get forum sentiment / trending financial topics."""
    posts = []

    # Method 1: Sina Finance rolling news as proxy (reliable financial sentiment)
    try:
        resp = requests.get(
            'https://feed.mix.sina.com.cn/api/roll/get',
            params={'pageid': '153', 'lid': '2516', 'num': '15', 'page': '1'},
            headers={'User-Agent': _UA},
            timeout=_TIMEOUT,
        )
        data = resp.json()
        items = data.get('result', {}).get('data', [])
        for item in items[:15]:
            title = item.get('title', '')
            if not title:
                continue
            posts.append({
                'content': title,
                'engagement': int(item.get('hits', 0) or 0),
                'author': '东财舆情',
                'time': 'now',
                'url': item.get('url', ''),
            })
    except Exception as e:
        logger.warning(f'EastMoney Sina finance news failed: {e}')

    # Method 2 fallback: concept boards (at least shows market-relevant topics)
    if not posts:
        try:
            resp = requests.get(
                'http://push2.eastmoney.com/api/qt/clist/get',
                params={
                    'pn': '1', 'pz': '10', 'po': '1', 'np': '1', 'fltt': '2',
                    'fid': 'f3', 'fs': 'm:90+t:3',
                    'fields': 'f3,f14',
                },
                headers={'User-Agent': _UA, 'Referer': 'http://quote.eastmoney.com/'},
                timeout=8,
                proxies=_NO_PROXY,
            )
            data = resp.json()
            if data.get('data') and data['data'].get('diff'):
                for item in data['data']['diff'][:10]:
                    name = str(item.get('f14', ''))
                    change = float(item.get('f3', 0))
                    posts.append({
                        'content': f'{name}概念 {"上涨" if change > 0 else "下跌"}{abs(change):.1f}%',
                        'engagement': 0,
                        'author': '东财概念',
                        'time': 'now',
                    })
        except Exception:
            pass

    return posts


def _get_xiaohongshu_hot():
    """Fetch Xiaohongshu hot posts via SSR explore page extraction (小红书发现页).
    The edith API (v1/search/hot) is dead (404). We extract notes from the
    server-rendered __INITIAL_STATE__ JSON embedded in the explore page HTML."""
    import re as _re
    import json as _json
    posts = []

    try:
        resp = requests.get(
            'https://www.xiaohongshu.com/explore',
            headers={
                'User-Agent': _UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9',
            },
            timeout=_TIMEOUT,
        )
        m = _re.search(
            r'window\.__INITIAL_(?:SSR_)?STATE__\s*=\s*(.+?)</script>',
            resp.text,
        )
        if m:
            raw = m.group(1).strip().rstrip(';')
            raw = _re.sub(r'\bundefined\b', 'null', raw)
            data = _json.loads(raw)
            feeds = data.get('feed', {}).get('feeds', [])
            for item in feeds[:15]:
                note = item.get('noteCard', {})
                title = note.get('displayTitle', '')
                if not title:
                    continue
                user = note.get('user', {})
                nickname = user.get('nickname', '')
                liked = note.get('interactInfo', {}).get('likedCount', '')
                note_id = item.get('id', '')
                note_type = note.get('type', '')  # video / normal
                # Parse liked count (e.g. "2.8万" → 28000)
                engagement = _parse_xhs_count(liked)
                posts.append({
                    'content': title,
                    'excerpt': f'{nickname} · 点赞 {liked}' if nickname else '',
                    'engagement': engagement,
                    'author': nickname or '小红书',
                    'time': 'now',
                    'url': f'https://www.xiaohongshu.com/explore/{note_id}' if note_id else '',
                })
            if posts:
                logger.warning(f'Xiaohongshu SSR OK: {len(posts)} notes from explore page')
    except Exception as e:
        logger.warning(f'Xiaohongshu SSR extraction failed: {e}')

    return posts


def _parse_xhs_count(s) -> int:
    """Parse xiaohongshu engagement count like '2.8万' → 28000, '10万+' → 100000."""
    if not s or not isinstance(s, str):
        return 0
    s = s.strip().replace('+', '')
    try:
        if '万' in s:
            return int(float(s.replace('万', '')) * 10000)
        return int(s)
    except (ValueError, TypeError):
        return 0


def _get_tieba_hot():
    """Fetch Tieba hot topics (贴吧热议) with title + excerpt + discussion count.
    Scrapes the hottopic browse page HTML for richer data than NewsNow."""
    from bs4 import BeautifulSoup
    posts = []
    try:
        resp = requests.get(
            'https://tieba.baidu.com/hottopic/browse/topicList',
            params={'res_type': '1'},
            headers={
                'User-Agent': _UA,
                'Referer': 'https://tieba.baidu.com/',
            },
            timeout=10,
        )
        if resp.status_code != 200:
            logger.warning(f'Tieba hottopic returned {resp.status_code}')
            return posts
        soup = BeautifulSoup(resp.text, 'html.parser')
        items = soup.select('.topic-top-item, .topic-item')
        for item in items[:15]:
            # Title
            title_el = item.select_one('.topic-text')
            title = title_el.get_text(strip=True) if title_el else ''
            if not title:
                continue
            # Excerpt/description
            desc_el = item.select_one('.topic-top-item-desc, .topic-desc')
            excerpt = desc_el.get_text(strip=True) if desc_el else ''
            # Discussion count
            num_el = item.select_one('.topic-num, .topic-hot-num')
            engagement = 0
            if num_el:
                num_text = num_el.get_text(strip=True)
                nums = re.findall(r'[\d.]+', num_text)
                if nums:
                    engagement = int(float(nums[0]))
                    if '万' in num_text:
                        engagement *= 10000
            # URL
            link_el = item.select_one('a[href]')
            url = ''
            if link_el:
                href = link_el.get('href', '')
                if href.startswith('http'):
                    url = href
                elif href.startswith('/'):
                    url = f'https://tieba.baidu.com{href}'
            posts.append({
                'content': title,
                'excerpt': excerpt,
                'engagement': engagement,
                'author': '贴吧热议',
                'time': 'now',
                'url': url,
            })
    except Exception as e:
        logger.warning(f'Tieba hot topics failed: {e}')
    return posts


def _get_bilibili_hot():
    """Fetch Bilibili popular videos (B站热门视频) with description.
    Uses popular API which returns video title + desc + stats."""
    posts = []
    try:
        resp = requests.get(
            'https://api.bilibili.com/x/web-interface/popular',
            params={'ps': '15', 'pn': '1'},
            headers={
                'User-Agent': _UA,
                'Referer': 'https://www.bilibili.com/',
            },
            timeout=_TIMEOUT,
        )
        data = resp.json()
        for item in (data.get('data', {}).get('list') or [])[:15]:
            title = item.get('title', '')
            if not title:
                continue
            desc = item.get('desc', '') or ''
            bvid = item.get('bvid', '')
            stat = item.get('stat', {})
            view = int(stat.get('view', 0) or 0)
            owner_name = (item.get('owner') or {}).get('name', '')
            posts.append({
                'content': title,
                'excerpt': desc if desc and desc != '-' else '',
                'engagement': view,
                'author': owner_name or 'B站热门',
                'time': 'now',
                'url': f'https://www.bilibili.com/video/{bvid}' if bvid else '',
            })
    except Exception as e:
        logger.warning(f'Bilibili popular failed: {e}')
    # Fallback to hot search if popular API fails
    if not posts:
        try:
            resp = requests.get(
                'https://api.bilibili.com/x/web-interface/wbi/search/square',
                params={'limit': '15'},
                headers={
                    'User-Agent': _UA,
                    'Referer': 'https://www.bilibili.com/',
                },
                timeout=_TIMEOUT,
            )
            data = resp.json()
            trending = data.get('data', {}).get('trending', {}).get('list', [])
            for item in trending[:15]:
                keyword = item.get('keyword', item.get('show_name', ''))
                posts.append({
                    'content': keyword,
                    'engagement': int(item.get('heat_score', 0)),
                    'author': 'B站热搜',
                    'time': 'now',
                    'url': f'https://search.bilibili.com/all?keyword={keyword}',
                })
        except Exception as e2:
            logger.warning(f'Bilibili hot search fallback also failed: {e2}')
    return posts


# ---------- Finance direct fetchers ----------

def _get_wallstreetcn_hot():
    """Fetch wallstreetcn (华尔街见闻) live feed."""
    posts = []
    try:
        resp = requests.get(
            'https://api-one-wscn.awtmt.com/apiv1/content/lives',
            params={'channel': 'global-channel', 'limit': '20'},
            headers={'User-Agent': _UA, 'Referer': 'https://wallstreetcn.com/'},
            timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        items = resp.json().get('data', {}).get('items', [])
        for item in items[:15]:
            text = item.get('content_text', '') or item.get('title', '')
            if not text:
                continue
            posts.append({
                'content': text[:200],
                'engagement': int(item.get('display_time', 0) or 0),
                'author': '华尔街见闻',
                'time': 'now',
                'url': f'https://wallstreetcn.com/live/{item.get("id", "")}',
            })
    except Exception as e:
        logger.warning(f'wallstreetcn fetch failed: {e}')
    return posts


def _get_jin10_hot():
    """Fetch jin10 (金十) flash news."""
    import json as _json
    posts = []
    try:
        resp = requests.get(
            'https://www.jin10.com/flash_newest.js',
            headers={'User-Agent': _UA, 'Referer': 'https://www.jin10.com/'},
            timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        text = resp.text
        if 'var newest' in text:
            json_str = text.split('=', 1)[1].strip().rstrip(';')
            data = _json.loads(json_str)
            items = list(data.values()) if isinstance(data, dict) else data
            for item in items[:15]:
                if not isinstance(item, dict):
                    continue
                content = item.get('data', {}).get('content', '') or item.get('content', '')
                if not content:
                    continue
                # Strip HTML tags
                import re as _re
                content = _re.sub(r'<[^>]+>', '', content)
                posts.append({
                    'content': content[:200],
                    'engagement': 0,
                    'author': '金十数据',
                    'time': 'now',
                    'url': 'https://www.jin10.com/',
                })
    except Exception as e:
        logger.warning(f'jin10 fetch failed: {e}')
    return posts


# ---------- News direct fetchers ----------

def _get_thepaper_hot():
    """Fetch thepaper (澎湃新闻) hot news."""
    posts = []
    try:
        resp = requests.get(
            'https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar',
            headers={'User-Agent': _UA},
            timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        items = resp.json().get('data', {}).get('hotNews', resp.json().get('data', []))
        if isinstance(items, list):
            for item in items[:15]:
                title = item.get('name', '') or item.get('title', '')
                if not title:
                    continue
                contId = item.get('contId', '')
                posts.append({
                    'content': title,
                    'engagement': int(item.get('praiseTimes', 0) or 0),
                    'author': '澎湃新闻',
                    'time': 'now',
                    'url': f'https://www.thepaper.cn/newsDetail_forward_{contId}' if contId else '',
                })
    except Exception as e:
        logger.warning(f'thepaper fetch failed: {e}')
    return posts


# ---------- Tech direct fetchers ----------

def _get_36kr_hot():
    """Fetch 36kr (36氪) newsflash."""
    posts = []
    try:
        resp = requests.get(
            'https://36kr.com/api/newsflash',
            params={'per_page': '20'},
            headers={'User-Agent': _UA},
            timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        data = resp.json().get('data', {})
        items = data.get('items', data.get('newsflashes', []))
        for item in items[:15]:
            title = item.get('title', '')
            if not title:
                continue
            posts.append({
                'content': title,
                'excerpt': item.get('description', '')[:200] if item.get('description') else '',
                'engagement': int(item.get('counter', {}).get('view', 0) or 0) if isinstance(item.get('counter'), dict) else 0,
                'author': '36氪',
                'time': 'now',
                'url': f'https://36kr.com/newsflashes/{item.get("id", "")}',
            })
    except Exception as e:
        logger.warning(f'36kr fetch failed: {e}')
    return posts


def _get_ithome_hot():
    """Fetch ithome (IT之家) news."""
    posts = []
    try:
        resp = requests.get(
            'https://m.ithome.com/api/news/newslistpageget',
            params={'type': '0', 'page': '1'},
            headers={
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) '
                              'AppleWebKit/605.1.15 (KHTML, like Gecko)',
            },
            timeout=_TIMEOUT, proxies=_NO_PROXY,
        )
        items = resp.json().get('Result', [])
        for item in items[:15]:
            title = item.get('title', '')
            if not title:
                continue
            posts.append({
                'content': title,
                'excerpt': item.get('description', '')[:200] if item.get('description') else '',
                'engagement': int(item.get('commentcount', 0) or 0),
                'author': 'IT之家',
                'time': 'now',
                'url': item.get('url', ''),
            })
    except Exception as e:
        logger.warning(f'ithome fetch failed: {e}')
    return posts
