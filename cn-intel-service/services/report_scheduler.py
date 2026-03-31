"""Background scheduler for auto-generating AI analysis reports.

Pre-generates mood report and gov news report on a schedule so they are
cached in Redis before users request them.  Follows the same daemon-thread
pattern as data_provider.start_bg_refresh().

Public API:
  build_mood_report(force=False)  — called by scheduler + /api/cn/mood/report
  build_gov_report(force=False)   — called by scheduler + /api/cn/gov-news/report
"""
import logging
import threading
import time
from datetime import datetime

logger = logging.getLogger('cn-intel.report-scheduler')

_started = False

# ── Report TTL ──
REPORT_TTL = 21600  # 6 hours


# ═══════════════════════════════════════════════════════════════════
#  Public: Mood Report
# ═══════════════════════════════════════════════════════════════════

def build_mood_report(force=False):
    """Build AI mood analysis report.  Returns dict or None.
    Reusable by both the background scheduler and the API endpoint."""
    from services.cache import cache_get, cache_set
    from services.media_crawler import get_social_mood
    from services.ai_analysis import call_ai

    cache_key = 'cn:mood:report'
    if not force:
        cached = cache_get(cache_key)
        if cached:
            return cached

    logger.warning('[report] Generating mood report...')

    # Gather mood data
    mood_cache = cache_get('cn:mood:social')
    if mood_cache:
        mood_data = mood_cache
    else:
        mood_data = get_social_mood()
        cache_set('cn:mood:social', mood_data, 600)

    # Build rich context — more posts, longer excerpts
    context_parts = []
    platforms = mood_data.get('platforms', {})
    for plat_name, posts in platforms.items():
        if not posts:
            continue
        lines = []
        for p in posts[:20]:  # up to 20 posts per platform
            content = p.get('content', '')
            if not content:
                continue
            sentiment = p.get('sentiment', '')
            engagement = p.get('engagement', 0)
            line = f"- [{sentiment}] {content[:200]}"
            if engagement:
                line += f" (互动:{engagement})"
            lines.append(line)
        if lines:
            context_parts.append(f'【{plat_name}】({len(posts)}条)\n' + '\n'.join(lines))

    # Add distribution
    dist = mood_data.get('distribution', {})
    if dist:
        total = dist.get('positive', 0) + dist.get('negative', 0) + dist.get('neutral', 0)
        context_parts.append(
            f'【情绪分布】总帖数:{total} — '
            f'正面:{dist.get("positive",0)} '
            f'负面:{dist.get("negative",0)} '
            f'中性:{dist.get("neutral",0)}'
        )

    # Add keywords
    keywords = mood_data.get('keywords', [])
    if keywords:
        kw_str = ', '.join(f"{k.get('word','')}({k.get('count',0)})" for k in keywords[:20])
        context_parts.append(f'【热词Top20】{kw_str}')

    # Add category breakdown if available
    categories = mood_data.get('categories', {})
    if categories:
        cat_lines = []
        for cat_name, cat_data in categories.items():
            if isinstance(cat_data, dict):
                cat_lines.append(
                    f"- {cat_name}: 正面{cat_data.get('positive',0)} "
                    f"负面{cat_data.get('negative',0)} 中性{cat_data.get('neutral',0)}"
                )
        if cat_lines:
            context_parts.append('【分类情绪】\n' + '\n'.join(cat_lines))

    # Add trend if available
    trend = mood_data.get('trend', {})
    if trend and trend.get('direction'):
        context_parts.append(f'【情绪趋势】方向: {trend["direction"]}')

    # Add platform breakdown if available
    plat_breakdown = mood_data.get('platform_breakdown', {})
    if plat_breakdown:
        pb_lines = []
        for pname, pdata in plat_breakdown.items():
            if isinstance(pdata, dict):
                pb_lines.append(
                    f"- {pname}: 正面{pdata.get('pos',0)} "
                    f"负面{pdata.get('neg',0)} 中性{pdata.get('neu',0)} "
                    f"总计{pdata.get('total',0)}"
                )
        if pb_lines:
            context_parts.append('【平台情绪对比】\n' + '\n'.join(pb_lines))

    if not context_parts:
        logger.warning('[report] No mood data, skip')
        return None

    context = '\n\n'.join(context_parts)
    prompt = f"""基于以下中国社交媒体和财经平台的多源舆情数据，生成一份深度全面的舆情分析报告。数据涵盖微博、知乎、小红书、东方财富、同花顺、雪球等平台的实时讨论。

{context}

请按以下结构输出（Markdown格式），每个板块都要有实质性内容：

## 舆情总览
（今日整体舆情基调分析：正面/负面/中性占比及其变化趋势。用具体数字说明，如"正面占比约XX%，较昨日有所上升/下降"。总结今日舆情的核心特征，如"市场情绪偏谨慎"或"科技板块讨论热度显著上升"。）

## 热点话题追踪
（社交平台最热门的5-8个话题。每个话题需包含：1）话题名称，2）核心讨论内容（20-30字），3）涉及的个股或板块，4）舆情倾向（偏多/偏空/分歧）。按热度排序。）

## 市场情绪深度分析
（1. 散户情绪：各平台散户讨论的主流观点，看多vs看空的核心论据分别是什么。2. 机构观点：研报和专业投资者的态度倾向。3. 情绪指标：结合互动量、关键词频率等量化指标分析。4. 与前日对比：情绪是在转暖还是趋冷。）

## 板块关注度分析
（按关注度排序列出前6-8个被讨论最多的板块/行业。每个板块需说明：1）讨论热度（高/中/低），2）舆论态度（看多/看空/分歧），3）驱动因素（消息面/技术面/资金面），4）典型讨论内容摘要。特别关注跨平台共振的板块。）

## 个股舆情聚焦
（列出今日被讨论最多的3-5只个股。每只股票需包含：1）讨论热度和情绪倾向，2）被讨论的核心原因，3）多空双方的核心论据。如数据中无明确个股则分析讨论最多的概念股方向。）

## 风险信号预警
（1. 恐慌信号：是否出现恐慌性言论、踩踏担忧等。2. 监管风险：是否有关于政策收紧、监管调查的讨论。3. 资金面风险：是否有关于流动性紧张、基金赎回的讨论。4. 黑天鹅苗头：是否有未被主流关注但可能发酵的负面信息。5. 舆情拐点：情绪是否出现极端值，可能反转。）

## 投资机会与策略
（基于舆情分析给出3-5条具体投资建议：1. 舆情共振机会：多平台同时看好的方向。2. 舆情拐点机会：情绪见底回升或过度悲观的板块。3. 回避方向：舆情持续恶化的板块/个股。4. 操作建议：仓位建议、买卖时机参考。每条建议须有舆情数据支撑。）

## 明日舆情展望
（基于今日舆情趋势，预判明日可能的舆情发展方向。哪些话题可能持续发酵？哪些板块讨论可能升温或降温？需要关注哪些潜在的舆情催化事件？）

要求：
1. 语言专业深入，每个板块至少3-5段分析，引用具体的舆情数据和帖子内容
2. 不要空泛笼统，须有具体的板块、个股、数据支撑
3. 多空观点都要呈现，给出均衡分析而非一面倒
4. 特别关注跨平台情绪共振和分歧
5. 不要使用markdown的加粗语法（不用**），直接用简洁文字表达"""

    report_text = call_ai(
        prompt,
        system_prompt='你是一位顶级的中国A股舆情分析师，擅长从多源社交媒体数据中挖掘市场情绪信号和投资机会。你的分析必须深入具体，引用原始数据，给出明确的投资方向判断。分析时需区分噪音与真正的市场信号，关注情绪拐点和跨平台共振。',
        max_tokens=6000,
    )

    if not report_text:
        logger.warning('[report] Mood report AI call failed')
        return None

    # Validate: check that at least 3 of the expected sections are present
    expected_sections = ['舆情总览', '热点话题', '市场情绪', '板块关注', '风险信号', '投资机会', '明日舆情']
    found = sum(1 for s in expected_sections if s in report_text)
    if found < 3:
        logger.warning(f'[report] Mood report incomplete: only {found}/7 sections found')

    result = {
        'report': report_text,
        'generated': True,
        'platform_count': len(platforms),
        'sections_found': found,
    }
    cache_set(cache_key, result, REPORT_TTL)
    logger.warning(f'[report] Mood report generated OK ({found}/7 sections)')
    return result


# ═══════════════════════════════════════════════════════════════════
#  Public: Gov Report
# ═══════════════════════════════════════════════════════════════════

def build_gov_report(force=False):
    """Build AI gov news policy report.  Returns dict or None.
    Reusable by both the background scheduler and the API endpoint."""
    from services.cache import cache_get, cache_set
    from services.gov_news_crawler import get_gov_news, GOV_CATEGORIES
    from services.ai_analysis import call_ai

    cache_key = 'cn:gov-news:report'
    if not force:
        cached = cache_get(cache_key)
        if cached:
            return cached

    logger.warning('[report] Generating gov report...')

    news_cache = cache_get('cn:gov-news')
    if news_cache:
        news_data = news_cache
    else:
        news_data = get_gov_news()
        cache_set('cn:gov-news', news_data, 1800)

    context_parts = []
    by_cat = news_data.get('categories', {})
    for cat in GOV_CATEGORIES:
        items = by_cat.get(cat, [])
        if not items:
            continue
        # Feed up to 20 items per category with date for temporal context
        lines = []
        for it in items[:20]:
            source = it.get('source', '')
            title = it['title']
            date = it.get('date', '')
            line = f"- [{source}] {title}"
            if date:
                line += f" ({date})"
            lines.append(line)
        context_parts.append(f'【{cat}】(共{len(items)}条，展示{len(lines)}条)\n' + '\n'.join(lines))

    if not context_parts:
        logger.warning('[report] No gov news data, skip')
        return None

    total_news = news_data.get('total', 0)
    context = '\n\n'.join(context_parts)
    prompt = f"""你是一位为机构投资者和政策研究团队服务的首席政策分析师。以下是今日中国官方媒体、政府部门和财经媒体的{total_news}条新闻标题（按来源分类）。请基于这些信息，撰写一份深度、专业、有独到见解的政策动态日报。

你的目标不是简单复述标题，而是：
- 透过标题发现政策的底层逻辑和方向性变化
- 找出不同部委政策之间的关联性和协同效应
- 识别政策信号的边际变化（与过去几周/月的政策基调相比）
- 将政策解读精确映射到具体的投资机会和风险

{context}

请按以下结构输出（Markdown格式）。每个板块都要有深度实质性分析，避免泛泛而谈：

## 今日政策全景：核心信号与方向判断
（用300-500字总结今日最重要的3-5条政策信号。不要逐条罗列，而是提炼出今天政策的"主旋律"和"边际变化"。回答：今天中国在释放什么信号？与上周/上月相比政策基调有何变化？哪些领域在加速、哪些在收紧？）

## 产业政策深度解读
（分析发改委/工信部/科技部/自然资源部/农业部等部委的产业相关政策。须做到：
- 指明政策利好的具体产业链环节（上游/中游/下游）
- 点名受益的A股二级行业和代表性上市公司（可用"XX行业龙头"代替）
- 评估政策的执行力度和时间节奏
- 与之前的产业政策对比，找出增量信息
如无相关新闻可省略。）

## 财政与税收政策
（财政部/税务总局相关政策。重点分析：
- 财政收支节奏（积极还是审慎？专项债发行进度如何？）
- 减税降费的目标行业和力度
- 政府投资方向（基建、科技、民生的优先级排序）
- 对经济增长和企业盈利的量化影响估计
如无可省略。）

## 货币与金融监管
（央行/金监总局/证监会/外汇局政策。须分析：
- 流动性信号：货币政策是在边际宽松还是收紧？有何具体操作？
- 金融监管新规对银行、券商、保险、公募、私募、理财的差异化影响
- 资本市场改革措施（IPO/再融资/退市/分红等）的市场含义
- 信贷投放方向和结构变化
如无可省略。）

## 纪检监察与治理
（中央纪委/监委动态。分析：涉及哪些行业/领域？是否形成行业性整顿趋势？对相关上市公司经营环境的影响。如无可省略。）

## 经济数据解读
（统计局/海关/商务部发布的数据。须做到：
- 数据本身的同比/环比变化
- 与市场一致预期的比较（超预期/不及预期）
- 对经济周期阶段判断的修正
- 数据公布后市场应该如何定价
如无可省略。）

## 国际政经与外交
（外交部/商务部/国际组织/地缘政治动态。须分析：
- 对中国外贸和出口企业的具体影响
- 对人民币汇率的传导路径
- 对北向资金和外资配置的影响
- 地缘风险溢价的变化
如无可省略。）

## 全球央行与流动性
（美联储/欧央行/日央行/IMF等动态。分析：
- 全球流动性环境的变化方向
- 中美利差和汇率的联动
- 对A股外资和港股的传导效应
- 中国央行的政策空间变化
如无可省略。）

## 央企国资与行业改革
（国资委/央企/行业性改革政策。关注：并购重组、薪酬改革、混改、央企考核指标变化等。如无可省略。）

## 财经媒体深度议题
（主流财经媒体关注的焦点话题。这些话题反映了市场参与者的关注方向和预期，有助于理解市场情绪的变化。如无可省略。）

## 跨市场影响评估矩阵
（这是核心产出，须做到极致的具体和专业：

A股市场：
- 明确看多的板块（至少3个），每个给出逻辑链条："XX政策→利好XX产业链→关注XX行业（代表性标的方向）"
- 明确看空/需回避的板块（至少2个），给出风险逻辑
- 整体市场情绪判断：今日政策面是偏多、偏空还是中性？边际变化？

债券市场：
- 利率债：收益率方向判断及核心驱动因素
- 信用债：哪些行业信用利差将收窄/走扩？
- 城投债：政策对城投平台的影响

汇率：人民币短期方向，核心影响因素排序

大宗商品：受政策影响最大的品种及方向判断）

## 投资策略建议（最重要）
（给出8-10条分级投资建议，按确定性和潜在收益排序：

高确定性策略（3-4条）：
每条包含——操作方向 | 具体标的方向（行业/板块/品种） | 政策依据 | 建议仓位比例 | 时间维度 | 核心风险

中等确定性策略（3-4条）：
需要进一步确认的机会，说明确认信号是什么

观察清单（2-3条）：
尚在酝酿中的机会，说明触发条件

特别提示：明确指出今天需要"回避"或"减仓"的方向。）

## 明日及本周政策日历
（列出未来1-5天需要重点关注的政策事件、数据发布和会议安排。每个事件须说明：预期影响方向、应对策略。）

要求：
1. 这是一份专业机构级别的政策分析报告，读者是基金经理和研究员，语言必须专业精确
2. 每个有内容的板块至少3-5段深度分析，杜绝"关注XX政策"这种空话
3. 投资建议必须具体到可以据此下单的程度（如"看多光伏组件行业龙头"而非"关注新能源"）
4. 区分政策的即期影响（1-3天）、短期影响（1-4周）和中期影响（1-3月）
5. 不要使用markdown的加粗语法（不用**），直接用简洁文字表达
6. 敢于给出明确判断，不要模棱两可"""

    report_text = call_ai(
        prompt,
        system_prompt='你是中国顶级券商的首席政策分析师，服务对象是管理百亿规模的机构投资者。你拥有20年政策研究经验，对中国政策制定的逻辑、节奏和信号传递机制有深刻理解。你的核心能力是：1）从海量政策信息中提炼出真正有投资价值的信号，2）将抽象的政策表述转化为具体的投资操作建议，3）捕捉政策边际变化和市场预期差。你的分析以"有用"为最高标准——每一段分析都要让读者知道"所以呢？我该怎么操作？"',
        max_tokens=8000,
    )

    if not report_text:
        logger.warning('[report] Gov report AI call failed')
        return None

    # Validate: check that key sections are present
    expected_sections = ['政策全景', '产业政策', '货币与金融', '跨市场影响', '投资策略', '政策日历']
    found = sum(1 for s in expected_sections if s in report_text)
    if found < 3:
        logger.warning(f'[report] Gov report incomplete: only {found}/6 sections found')

    result = {
        'report': report_text,
        'generated': True,
        'news_total': news_data.get('total', 0),
        'sources': news_data.get('sources', {}),
        'sections_found': found,
    }
    cache_set(cache_key, result, REPORT_TTL)
    logger.warning(f'[report] Gov report generated OK ({found}/6 sections)')
    return result


# ═══════════════════════════════════════════════════════════════════
#  Public: Policy Flash (breaking news alerts)
# ═══════════════════════════════════════════════════════════════════

# High-importance sources that trigger flash alerts
FLASH_SOURCES = {'国务院', '央行', '证监会', '金监总局', '发改委', '财政部'}
FLASH_CATEGORY_KEYWORDS = {'国务院', '财政货币', '金融监管'}

def build_policy_flash(new_items: list) -> list:
    """Check new policy items for high-importance ones and generate flash alerts.
    Returns list of flash dicts. Also stores to Redis list."""
    from services.cache import cache_get, cache_set
    from services.ai_analysis import call_ai
    import redis
    from config import Config

    if not new_items:
        return []

    # Filter for high-importance items
    flash_candidates = []
    for item in new_items:
        source = item.get('source', '')
        category = item.get('category', '')
        title = item.get('title', '')
        if not title:
            continue
        # Check if from high-importance source or category
        is_important = (
            any(src in source for src in FLASH_SOURCES) or
            category in FLASH_CATEGORY_KEYWORDS or
            any(kw in title for kw in ['国务院', '央行', '降息', '降准', '紧急', '重大'])
        )
        if is_important:
            flash_candidates.append(item)

    if not flash_candidates:
        return []

    # Check dedup: don't re-flash same title
    import hashlib
    flashes = []
    for item in flash_candidates[:5]:
        title = item.get('title', '')
        flash_hash = hashlib.md5(title.encode()).hexdigest()
        dedup_key = f'cn:policy:flash:seen:{flash_hash}'
        if cache_get(dedup_key):
            continue

        # Generate quick AI summary
        summary = ''
        try:
            result = call_ai(
                f'用50字概括以下政策标题的核心内容和市场影响方向（利好/利空/中性）：\n{title}',
                system_prompt='你是政策快报编辑。极简输出：50字概述+方向判断。',
                max_tokens=200,
            )
            summary = result or ''
        except Exception:
            pass

        flash = {
            'title': title,
            'source': item.get('source', ''),
            'category': item.get('category', ''),
            'date': item.get('date', ''),
            'url': item.get('url', ''),
            'summary': summary,
            'timestamp': datetime.now().isoformat(),
            'importance': 'high',
        }
        flashes.append(flash)
        cache_set(dedup_key, True, 86400)  # 24h dedup

    # Store to Redis list
    if flashes:
        try:
            r = redis.Redis(host=Config.REDIS_HOST, port=Config.REDIS_PORT, db=Config.REDIS_DB)
            for flash in flashes:
                import json as _json
                r.lpush('cn:policy:flash', _json.dumps(flash, ensure_ascii=False))
            r.ltrim('cn:policy:flash', 0, 49)  # Keep last 50
            logger.warning(f'[flash] Generated {len(flashes)} policy flash alerts')
        except Exception as e:
            logger.warning(f'[flash] Redis store error: {e}')

    return flashes


def get_policy_flashes(limit: int = 20) -> list:
    """Retrieve recent policy flash alerts from Redis."""
    import redis
    from config import Config

    try:
        r = redis.Redis(host=Config.REDIS_HOST, port=Config.REDIS_PORT, db=Config.REDIS_DB)
        raw = r.lrange('cn:policy:flash', 0, limit - 1)
        import json as _json
        return [_json.loads(item) for item in raw]
    except Exception as e:
        logger.warning(f'[flash] Redis read error: {e}')
        return []


# ═══════════════════════════════════════════════════════════════════
#  Enterprise Report Schedules (per-user)
# ═══════════════════════════════════════════════════════════════════

_SCHED_KEY_PREFIX = 'cn:report_schedule:'


def get_user_schedules(user_id: str) -> list:
    """Get all schedule configs for a user."""
    from flask import current_app
    import json
    try:
        r = current_app.redis
    except Exception:
        return []
    if not r:
        return []

    raw = r.get(f'{_SCHED_KEY_PREFIX}{user_id}')
    if not raw:
        return []

    try:
        data = raw if isinstance(raw, str) else raw.decode()
        return json.loads(data)
    except (json.JSONDecodeError, TypeError, AttributeError):
        return []


def save_user_schedules(user_id: str, schedules: list) -> None:
    """Save schedule configs for a user."""
    from flask import current_app
    import json
    try:
        r = current_app.redis
    except Exception:
        logger.warning('[enterprise-sched] No app context, cannot save schedules')
        return
    if not r:
        logger.warning('[enterprise-sched] Redis not available, cannot save schedules')
        return

    valid_types = {'daily', 'weekly', 'monthly', 'quarterly', 'annual'}
    cleaned = []
    for s in schedules:
        stype = s.get('type', '')
        if stype not in valid_types:
            continue
        cleaned.append({
            'type': stype,
            'enabled': bool(s.get('enabled', False)),
            'time': str(s.get('time', '09:00'))[:5],
            'day_of_week': int(s.get('day_of_week', 0)) if stype == 'weekly' else None,
            'day_of_month': int(s.get('day_of_month', 1)) if stype in ('monthly', 'quarterly', 'annual') else None,
        })

    r.set(f'{_SCHED_KEY_PREFIX}{user_id}', json.dumps(cleaned))
    logger.warning(f'[enterprise-sched] Saved {len(cleaned)} schedules for user {user_id}')


def _check_enterprise_schedules():
    """Check all user schedules and trigger report generation if due."""
    from flask import current_app
    import json
    try:
        r = current_app.redis
    except Exception:
        return
    if not r:
        return

    now = datetime.now()
    current_h, current_m = now.hour, now.minute

    # Scan for all schedule keys
    keys = []
    cursor = 0
    while True:
        cursor, batch = r.scan(cursor, match=f'{_SCHED_KEY_PREFIX}*', count=100)
        keys.extend(batch)
        if cursor == 0:
            break

    prefix_len = len(_SCHED_KEY_PREFIX)
    for key in keys:
        key_str = key.decode() if isinstance(key, bytes) else key
        user_id = key_str[prefix_len:]

        raw = r.get(key)
        if not raw:
            continue
        try:
            data = raw if isinstance(raw, str) else raw.decode()
            schedules = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            continue

        for sched in schedules:
            if not sched.get('enabled'):
                continue

            time_str = sched.get('time', '09:00')
            try:
                target_h, target_m = int(time_str.split(':')[0]), int(time_str.split(':')[1])
            except (ValueError, IndexError):
                continue

            if current_h != target_h or current_m != target_m:
                continue

            stype = sched['type']
            should_run = False
            if stype == 'daily':
                should_run = True
            elif stype == 'weekly':
                should_run = now.weekday() == sched.get('day_of_week', 0)
            elif stype == 'monthly':
                should_run = now.day == sched.get('day_of_month', 1)
            elif stype == 'quarterly':
                should_run = now.month in (1, 4, 7, 10) and now.day == sched.get('day_of_month', 1)
            elif stype == 'annual':
                should_run = now.month == 1 and now.day == sched.get('day_of_month', 1)

            if not should_run:
                continue

            # Dedup: only run once per type per user per minute
            dedup_key = f'cn:sched_run:{user_id}:{stype}:{now.strftime("%Y%m%d%H%M")}'
            if not r.set(dedup_key, '1', ex=120, nx=True):
                continue

            # Generate report in background thread
            import threading as _threading
            _threading.Thread(
                target=_run_enterprise_report,
                args=(user_id, stype),
                daemon=True,
            ).start()


def _run_enterprise_report(user_id: str, report_type: str) -> None:
    """Generate a scheduled enterprise report and archive it."""
    try:
        from services.enterprise_reports import (
            generate_daily_report, generate_weekly_report,
            generate_monthly_report, generate_quarterly_report,
            generate_annual_report,
        )

        generators = {
            'daily': generate_daily_report,
            'weekly': generate_weekly_report,
            'monthly': generate_monthly_report,
            'quarterly': generate_quarterly_report,
            'annual': generate_annual_report,
        }

        gen = generators.get(report_type)
        if not gen:
            return

        logger.warning(f'[enterprise-sched] Generating scheduled {report_type} for user {user_id}')
        report = gen(user_id=user_id)

        try:
            from services.report_archive import archive_report
            archive_report(user_id, report_type, report)
            logger.warning(f'[enterprise-sched] Archived {report_type} for user {user_id}')
        except Exception as e:
            logger.warning(f'[enterprise-sched] Archive failed: {e}')

    except Exception as e:
        logger.warning(f'[enterprise-sched] Failed to generate {report_type} for {user_id}: {e}')


# ═══════════════════════════════════════════════════════════════════
#  Background Loop
# ═══════════════════════════════════════════════════════════════════

def _report_loop(app):
    """Background loop: check every minute for scheduled reports, 30 min for mood/gov."""
    # Initial delay: let data sources warm up first
    time.sleep(60)

    last_mood_gov_check = 0

    while True:
        try:
            now = datetime.now()
            # Skip weekends + midnight-6am (no useful data)
            if now.weekday() < 5 and now.hour >= 6:
                with app.app_context():
                    # Check enterprise schedules every minute
                    try:
                        _check_enterprise_schedules()
                    except Exception as e:
                        logger.warning(f'[enterprise-sched] Check error: {e}')

                    # Check mood/gov reports every 30 min
                    elapsed = time.time() - last_mood_gov_check
                    if elapsed >= 1800:
                        last_mood_gov_check = time.time()
                        build_mood_report()
                        build_gov_report()
                        try:
                            from services.enterprise_reports import check_scheduled_reports
                            check_scheduled_reports()
                        except Exception as e:
                            logger.warning(f'[report-scheduler] Enterprise report error: {e}')
        except Exception as e:
            logger.warning(f'[report-scheduler] Loop error: {e}')

        # Check every 60 seconds for enterprise schedules
        time.sleep(60)


def start_report_scheduler(app):
    """Start background daemon thread for report auto-generation.
    Call once at app startup, after data providers are initialized.
    """
    global _started
    if _started:
        return
    _started = True
    t = threading.Thread(target=_report_loop, args=(app,), daemon=True, name='report-scheduler')
    t.start()
    logger.warning('[report-scheduler] Background report scheduler started')
