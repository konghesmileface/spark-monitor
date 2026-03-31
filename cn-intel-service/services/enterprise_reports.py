"""Enterprise report generation — personalized weekly/monthly/quarterly/annual reports.

Quality target: 券商研究所 level — multi-dimensional analysis covering:
  宏观/微观/中观/产业/地区/国家/竞争/国际环境/财政政策/货币政策

Output: dict + exportable HTML.
Focus: 产业/企业视角 — 供应链、合规、竞争格局、经营风险与机遇。
"""

import json
import logging
import time
from datetime import date, datetime, timedelta

from services.global_signals import build_global_signal_context

logger = logging.getLogger('cn-intel.enterprise-reports')


def _acquire_report_lock(cache_key: str, timeout: int = 90) -> bool:
    """Try to acquire a Redis lock for report generation. Returns True if
    acquired, False if another worker holds it, True if Redis unavailable."""
    from services.cache import get_redis
    r = get_redis()
    if not r:
        return True
    try:
        return bool(r.set(f'{cache_key}:lock', '1', ex=timeout, nx=True))
    except Exception:
        return True


def _release_report_lock(cache_key: str) -> None:
    from services.cache import get_redis
    r = get_redis()
    if r:
        try:
            r.delete(f'{cache_key}:lock')
        except Exception:
            pass


def _wait_for_cache(cache_key: str, timeout: int = 60):
    """Poll Redis cache until the value appears or timeout."""
    from services.cache import cache_get
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.5)
        val = cache_get(cache_key)
        if val is not None:
            return val
    return None

# ── Research-grade system prompts ────────────────────────────────────────────

REPORT_SYSTEM_DAILY = """你是服务于中国企业CEO的首席情报分析师，分析水准对标券商研究所首席分析师。

撰写每日政策速览时，必须覆盖以下分析维度：
- 宏观定位：当日宏观经济数据/会议/讲话对行业的传导
- 财政/货币：当日财政和货币政策动向(如MLF/逆回购/专项债/补贴)对企业融资和成本的影响
- 产业链：政策在上中下游的差异化传导
- 竞争视角：对企业vs竞对的差异化影响
- 国际联动：当日国际事件(汇率/大宗商品/地缘/贸易)对企业的影响
- 区域差异：政策在不同经营区域的执行差异

每条分析要有因果链推演(A→B→C)和量化锚点。不接受"建议关注""可能影响"等模糊表述。
每份日报必须以"CEO今日行动清单"结尾，列出3-5条具体行动（做什么+找谁+何时完成）。
提到竞争对手时必须使用企业画像中的具体公司名，不要泛泛而谈"竞对"。
供应链分析需包含上游价格变化的具体数字（如原材料涨跌幅度）。
使用Markdown格式输出，善用**加粗**、表格、列表增强可读性。"""

REPORT_SYSTEM_WEEKLY = """你是服务于中国企业CEO的首席情报分析师，分析水准对标券商研究所首席分析师+麦肯锡咨询顾问。

撰写周度情报时，必须达到以下研究深度：
- 宏观研判：本周宏观经济运行(GDP/CPI/PPI/PMI/社融/M2)+经济周期定位(复苏/过热/滞胀/衰退)
- 财政政策：本周财政动向(专项债/减税/补贴/产业基金/地方债)对行业的量化影响
- 货币政策：本周货币动向(LPR/MLF/逆回购/信贷投放)+融资环境变化对企业资金成本的影响
- 中观产业：行业景气度(PMI分项/开工率/产能利用率)、产能周期、库存周期
- 微观企业：政策对目标企业营收/毛利率/费用率/现金流的具体影响推演
- 竞争格局：行业集中度变化、竞对战略动向(并购/扩产/裁员)、Porter五力变化
- 产业链传导：上游→中游→下游的价格/供需传导链，各环节议价能力变化
- 区域经济：企业所在区域的特殊政策/产业集群优势/区域竞争
- 国际环境：中美/中欧/RCEP/汇率/大宗商品/地缘冲突对企业的传导影响
- 全球供应链：友岸外包/近岸外包/出口管制/技术脱钩对产业链的重构影响
- 监管合规：数据安全/反垄断/环保/ESG/行业准入等监管趋势

分析必须有因果链(政策→行业效应→企业影响→建议行动)，有量化数据，有国际对标。
每章分析必须引用企业画像中的竞争对手、供应链上下游的具体名称。
第十章"风险与机遇"表格必须包含estimated_value列（预估财务影响）。
结尾增加"高管行动矩阵"：CEO/CFO/CMO/CSO各1-2条本周关键行动。
使用Markdown格式，善用**加粗**、表格、编号列表。"""

REPORT_SYSTEM_MONTHLY = """你是服务于中国企业CEO的首席战略情报顾问，分析水准对标国际投行研究部+BCG战略咨询。

月度报告是CEO战略决策的核心参考，分析深度必须超越市面上的券商月报：
- 宏观经济全景：月度GDP先行指标/CPI-PPI剪刀差/信贷脉冲/PMI结构/就业数据，明确经济周期位置
- 财政-货币政策联动：财政发力方向(基建/消费/科技)+货币配合节奏(降准降息/结构性工具)+政策效果评估
- 产业景气跟踪：月度行业核心指标(产量/销量/价格/库存/订单/开工率)趋势，景气度环比/同比变化
- 供应链月度变化：上下游价格传导、供需缺口演变、库存天数变化、关键原材料价格走势
- 竞争格局月度演变：月度市场份额变化、竞对重大动作(投融资/新品/组织调整/战略发布)
- 国际形势月度回顾：中美关系/贸易数据/汇率变动/大宗商品/地缘风险事件回顾及影响评估
- 区域经济差异：各区域(长三角/珠三角/京津冀/成渝/中西部)政策和产业发展差异
- 合规风险月报：新增监管政策/执法案例/合规要求变化/行业准入门槛变化
- 技术路线月度：技术迭代进展/国产替代进度/标准制定动态
- 情景分析：乐观/基准/悲观三种情景下的企业经营影响推演

报告要具备战略高度(看方向)+操作深度(给行动)。每章结论用"■ 核心判断"总结。
增加"CEO月度决策清单"章节，列5-8条可立即执行的决策建议，每条含负责人+deadline+预期效果。
竞争格局分析必须包含具体企业名称和市值/营收数据的对比。
使用Markdown格式，善用**加粗**、表格、编号列表。约4000-6000字。"""

REPORT_SYSTEM_QUARTERLY = """你是服务于中国企业CEO/董事会的首席战略顾问，分析水准对标McKinsey/BCG季度战略回顾+国际投行行业深度研究。

季度战略报告是企业调整经营策略的核心依据，分析框架要全面覆盖：

【宏观经济】季度GDP增速/通胀/就业/贸易数据回顾，经济周期阶段判断(复苏→过热→滞胀→衰退)，与前季环比趋势
【财政政策】季度财政发力评估：专项债发行进度/减税降费落地/产业补贴到位情况/地方债务风险，评估财政乘数效应
【货币政策】季度货币环境：利率走廊变化/信贷投放结构/社融增速/M2-M1剪刀差，评估流动性对企业的影响
【产业周期】行业季度景气度评估：产能利用率变化/库存周期位置/资本开支变化/行业盈利能力(毛利率/ROE)趋势
【竞争格局】季度CR3/CR5变化、重大并购/融资/IPO事件、竞对季报关键指标对比、新进入者/退出者
【供应链】季度供应链风险评估：关键原材料价格趋势/供应集中度/替代方案成熟度/物流成本变化
【国际形势】季度国际环境变化：中美关系走向/贸易数据/汇率波动/大宗商品超级周期/地缘冲突演变
【区域发展】季度区域政策差异和产业转移趋势，重点园区/自贸区/经开区政策变化
【技术路线】季度技术进步评估：国产替代进度/新技术商业化/标准制定/专利态势
【合规监管】季度监管趋势：新法规/执法力度/行业整改/数据安全/ESG要求升级

关键要求：
1. 每章用"■ 季度核心判断"开头，一句话结论
2. 量化对比：本季vs上季/去年同期，用%和绝对值双标注
3. 战略建议必须分短期(1-3月)/中期(3-12月)/长期(1-3年)
4. 包含情景分析(乐观/基准/悲观)及触发条件
5. 约4000-5000字，兼具战略高度和操作细节
6. 情景分析必须给出具体触发条件和对应的财务影响区间
7. 增加"季度CEO行动计划"，分3个月列出关键行动和里程碑

使用Markdown格式。"""

REPORT_SYSTEM_ANNUAL = """你是服务于中国企业CEO/董事会的首席战略规划师，分析水准对标McKinsey年度战略回顾+高盛全球宏观年报+国际投行行业年度展望。

年度战略回顾是企业制定来年战略规划的核心文件，必须具备以下深度和广度：

【全年宏观回顾】年度GDP/CPI/PPI/PMI/就业/贸易顺差/外汇储备全景，经济周期定位与转折点识别，与十四五规划目标的对照
【财政政策年度】全年财政政策评估：赤字率/专项债规模/减税降费效果/产业政策导向/地方债风险化解，评估财政政策的行业传导效率
【货币政策年度】全年货币政策回顾：降准降息节奏/信贷结构优化/汇率管理/跨境资本流动，评估货币环境对行业的影响路径
【产业全景】行业年度发展全景：市场规模/增速/渗透率变化/技术路线演进/产能周期位置/行业盈利周期(毛利率/ROIC趋势)
【竞争格局年变】年度竞争格局深度分析：CR3/CR5年度变化/重大并购事件/上市公司年报关键指标对比/战略转型案例
【国际形势年度】年度国际环境回顾：中美关系全年演变/全球供应链重构进展/RCEP实施效果/汇率年度波动/大宗商品超级周期/地缘冲突影响
【区域经济年度】各重点区域年度发展差异：产业集群形成/区域竞争力变化/人才流动/产业转移趋势
【技术演进年度】年度技术路线回顾：关键技术突破/国产替代里程碑/新标准发布/专利格局变化/AI等通用技术对行业的渗透
【监管年度回顾】年度监管环境变化：重大法规/执法案例/合规成本变化/ESG要求升级/数据安全等
【来年展望】
  - 宏观预判：GDP/CPI/利率/汇率预测区间
  - 行业预判：景气度/产能/库存/价格预测
  - 政策预判：财政/货币/产业政策方向预测
  - 战略建议：来年战略重点(3-5个)，分优先级
  - 关键里程碑：来年12个月的关键决策时点和行动计划
  - 情景规划：乐观(概率30%)/基准(50%)/悲观(20%)三情景下的经营策略

关键要求：
1. 具备CEO年度战略汇报的深度和广度，可直接用于董事会汇报
2. 每章用"■ 年度核心判断"开头
3. 量化对比必须有年度同比+趋势判断(加速/减速/转折)
4. 来年展望必须有具体的量化预测区间和概率评估
5. 约5000-7000字
6. 来年展望必须包含月度关键决策时点日历
7. 增加"CEO年度行动路线图"，按季度列出战略目标和关键里程碑

使用Markdown格式。"""


# ── Shared helpers ───────────────────────────────────────────────────────────

def _safe_call(fn, default=None):
    """Call fn() and return default on any exception."""
    try:
        result = fn()
        return result if result is not None else default
    except Exception as e:
        logger.debug(f'_safe_call({getattr(fn, "__name__", "lambda")}) error: {e}')
        return default


def _format_market_lines(sector_rank, north, macro, margin):
    """Format market data into prompt lines."""
    lines = []
    if sector_rank:
        lines.append('板块涨跌TOP5: ' + ', '.join(
            f'{s.get("name","")}{s.get("changePercent",0):+.2f}%' for s in sector_rank[:5]))
    if north and north.get('totalFlow'):
        lines.append(f'北向资金: {north.get("direction","")}{north["totalFlow"]}万元')
    if margin and margin.get('balance'):
        lines.append(f'融资融券余额: {margin["balance"]} (日变化{margin.get("change","N/A")})')
    macro_parts = []
    for k in ['cpi', 'ppi', 'pmi']:
        vals = (macro or {}).get(k, [])
        if vals:
            macro_parts.append(f'{k.upper()}:{vals[0].get("value","N/A")}')
    if macro_parts:
        lines.append(f'宏观指标: {" | ".join(macro_parts)}')
    return lines


def _gather_all_data(user_id, profile):
    """Gather comprehensive multi-dimensional data for report generation.

    Collects: market, macro, cross-domain signals, regime, sentiment,
    alerts, keyword trends, industry brief, global OSINT.
    Returns dict with all available data components.
    """
    from services.cache import cache_get
    from services.data_provider import (get_sector_rank, get_north_flow,
                                         get_macro_indicators, get_margin_data,
                                         get_sector_rotation)

    d = {}

    # Market data
    d['sector_rank'] = _safe_call(lambda: get_sector_rank(top_n=5), [])
    d['north'] = _safe_call(get_north_flow, {})
    d['macro'] = _safe_call(get_macro_indicators, {})
    d['margin'] = _safe_call(get_margin_data, {})
    d['rotation'] = _safe_call(lambda: get_sector_rotation(top_n=10), {})

    # Cross-domain signals & regime
    try:
        from services.cross_domain_engine import (build_correlation_context,
                                                    detect_cross_signals, detect_regime)
        sectors = profile.get('industries', []) if profile else []
        ctx = build_correlation_context(sectors)
        d['cross_signals'] = detect_cross_signals(ctx)[:5]
        d['regime'] = detect_regime() or {}
    except Exception as e:
        logger.debug(f'_gather_all_data: cross_domain error: {e}')
        d['cross_signals'] = []
        d['regime'] = {}

    # Sentiment / mood
    d['mood'] = cache_get('cn:mood:social') or {}

    # Alerts
    d['alerts'] = []
    d['alert_stats'] = {}
    if user_id:
        try:
            from services.alert_engine import get_user_alerts, get_alert_stats
            d['alert_stats'] = get_alert_stats(user_id, days=7) or {}
            for tier in ('FLASH', 'PRIORITY'):
                d['alerts'].extend(get_user_alerts(user_id, tier=tier, limit=5))
        except Exception as e:
            logger.debug(f'_gather_all_data: alerts error: {e}')

    # Keyword trends
    try:
        from services.keyword_trends import compute_keyword_trends
        d['kw_trends'] = compute_keyword_trends(days_back=7) or []
    except Exception as e:
        logger.debug(f'_gather_all_data: keyword_trends error: {e}')
        d['kw_trends'] = []

    # Industry brief (cached)
    try:
        from services.industry_advisor import generate_industry_brief
        d['industry_brief'] = generate_industry_brief(user_id) if user_id else None
    except Exception as e:
        logger.debug(f'_gather_all_data: industry_brief error: {e}')
        d['industry_brief'] = None

    # Global OSINT
    d['global_text'] = ''
    if user_id:
        try:
            d['global_text'] = build_global_signal_context(user_id, max_items=5)
        except Exception as e:
            logger.debug(f'_gather_all_data: global_osint error: {e}')

    return d


def _data_to_prompt_lines(data, compact=False):
    """Convert gathered data dict into prompt text lines for AI prompt injection."""
    lines = []

    # Market & Macro
    ml = _format_market_lines(data.get('sector_rank', []), data.get('north', {}),
                               data.get('macro', {}), data.get('margin', {}))
    if ml:
        lines.append('\n━━ 市场与宏观数据 ━━')
        lines.extend(ml)

    # Rotation
    rot = data.get('rotation', {})
    rot_sectors = rot.get('sectors', []) if isinstance(rot, dict) else []
    if rot_sectors:
        lines.append('板块轮动: ' + ', '.join(
            f'{s.get("name","")}{s.get("momentum",0):+.1f}({s.get("status","")})' for s in rot_sectors[:5]))

    # Regime
    regime = data.get('regime', {})
    if regime and regime.get('label'):
        lines.append(f'市场状态: {regime["label"]} — {regime.get("description", "")}')

    # Sentiment
    mood = data.get('mood', {})
    dist = mood.get('distribution', {})
    if dist:
        lines.append('\n━━ 舆情与情绪 ━━')
        lines.append(f'舆情: 正面{dist.get("positive",0)} 负面{dist.get("negative",0)} 中性{dist.get("neutral",0)}')
        kws = mood.get('keywords', [])
        if kws:
            n = 8 if compact else 12
            lines.append(f'热词: {", ".join(k.get("word","") for k in kws[:n])}')

    # Cross-domain signals
    sigs = data.get('cross_signals', [])
    if sigs:
        lines.append(f'\n━━ 跨域关联信号({len(sigs)}个) ━━')
        for s in sigs[:5]:
            lines.append(f'  - [{s.get("pattern","")}] {s.get("description","")} (置信度:{s.get("confidence",0):.0%})')

    # Alerts
    alerts = data.get('alerts', [])
    if alerts:
        n = 5 if compact else 8
        lines.append(f'\n━━ 告警({len(alerts)}条) ━━')
        for a in alerts[:n]:
            lines.append(f'  - [{a.get("tier","")}] {a.get("title","")}')

    # Keyword trends
    kw = data.get('kw_trends', [])
    if kw:
        rising = [t for t in kw if t.get('trend') == 'rising'][:5]
        if rising:
            lines.append('\n━━ 关键词趋势 ━━')
            for t in rising:
                lines.append(f'  ↑ {t.get("keyword","")} (频率+{t.get("change",0):.0%})')

    # Industry brief headline
    ib = data.get('industry_brief')
    if ib and isinstance(ib, dict) and ib.get('headline'):
        lines.append('\n━━ 产业洞察 ━━')
        lines.append(f'产业研判: {ib["headline"]}')
        if ib.get('risk_level'):
            lines.append(f'产业风险: {ib["risk_level"]}')

    # Global OSINT
    gs = data.get('global_text', '')
    if gs:
        lines.append('\n━━ 全球信号(OSINT) ━━')
        lines.append(gs)

    return lines


# ── Report generators ────────────────────────────────────────────────────────

def generate_weekly_report(user_id: str = None) -> dict:
    """Generate a personalized weekly intelligence report — 12 dimensions + action matrix."""
    from services.cache import cache_get, cache_set, get_redis
    from services.ai_analysis import call_ai
    from services import policy_store

    cache_key = f'cn:enterprise:weekly:{user_id}' if user_id else 'cn:enterprise:weekly:global'
    cached = cache_get(cache_key)
    if cached:
        return cached
    # Stampede protection — only one request generates the report
    lock_acquired = _acquire_report_lock(cache_key)
    if lock_acquired is False:
        # Another worker is generating — wait for it
        result = _wait_for_cache(cache_key, timeout=60)
        if result is not None:
            return result

    today = date.today()
    week_ago = today - timedelta(days=7)

    # ── 1. Policies ────────────────────────────────────────────────
    policies = policy_store.get_items_by_date_range(
        week_ago.isoformat(), today.isoformat(), limit=200)

    profile = None
    if user_id:
        from services.user_profile import get_profile
        profile = get_profile(user_id)

    if profile:
        from services.relevance_scorer import filter_items_for_user
        relevant_policies = filter_items_for_user(policies, profile, min_relevance=0.2)
    else:
        relevant_policies = policies

    # ── 2. Comprehensive data ──────────────────────────────────────
    data = _gather_all_data(user_id, profile)
    mood = data.get('mood', {})
    dist = mood.get('distribution', {})
    keywords = mood.get('keywords', [])

    # ── 3. User profile context ────────────────────────────────────
    company_name = ''
    competitors = []
    industries = []
    supply_up = []
    supply_down = []
    compliance = []
    regions = []
    business_scope = ''
    if profile:
        company_name = profile.get('company_name', '')
        competitors = profile.get('competitors', [])
        industries = profile.get('industries', [])
        supply_up = profile.get('supply_chain_up', [])
        supply_down = profile.get('supply_chain_down', [])
        compliance = profile.get('compliance_concerns', [])
        regions = profile.get('business_regions', [])
        business_scope = profile.get('business_scope', '')

    # ── 4. Build prompt ────────────────────────────────────────────
    parts = [
        f'生成企业周度情报简报 ({week_ago.isoformat()} ~ {today.isoformat()}):',
    ]
    if company_name:
        parts.append(f'服务企业: {company_name}')
    if business_scope:
        parts.append(f'主营业务: {business_scope}')
    if industries:
        parts.append(f'所在行业: {", ".join(industries)}')
    if supply_up:
        parts.append(f'上游供应链: {", ".join(supply_up)}')
    if supply_down:
        parts.append(f'下游客户/渠道: {", ".join(supply_down)}')
    if competitors:
        parts.append(f'主要竞争对手: {", ".join(competitors)}')
    if compliance:
        parts.append(f'合规关注点: {", ".join(compliance)}')
    if regions:
        parts.append(f'经营区域: {", ".join(regions)}')

    parts.append(f'\n━━ 本周政策({len(relevant_policies)}条相关 / {len(policies)}条总计) ━━')
    for p in relevant_policies[:12]:
        score = p.get('_relevance_score', 0)
        parts.append(f'  - {p.get("title","")} (相关度:{score:.2f}, {p.get("source","")})')

    # Inject all data dimensions
    parts.extend(_data_to_prompt_lines(data))

    parts.append(
        '\n请用Markdown格式输出完整企业周度情报（券商研究所+麦肯锡水准），包含12个章节:\n'
        '## 一、本周宏观研判\n'
        '- 本周宏观经济运行(GDP/CPI/PPI/PMI/社融/M2)+经济周期定位(复苏/过热/滞胀/衰退)\n\n'
        '## 二、财政政策动向\n'
        '- 本周财政动向(专项债/减税/补贴/产业基金)对行业的量化影响\n\n'
        '## 三、货币政策与融资环境\n'
        '- 本周LPR/MLF/逆回购/信贷投放变化对企业资金成本的影响\n\n'
        '## 四、本周政策要点\n'
        '- 3-5条与企业最相关政策，每条: **标题** + 因果链分析(政策→行业→企业)\n\n'
        '## 五、中观产业动态\n'
        '- 行业景气度(PMI分项/开工率/产能利用率)、库存周期位置\n\n'
        '## 六、竞争格局\n'
        '- 竞对战略动向(并购/扩产/裁员)、Porter五力变化\n\n'
        '## 七、产业链传导\n'
        '- 上游→中游→下游价格/供需传导链，各环节议价能力变化\n\n'
        '## 八、国际环境与全球供应链\n'
        '- 中美/中欧/RCEP/汇率/大宗商品/地缘冲突 + 友岸外包/出口管制影响\n\n'
        '## 九、监管合规\n'
        '- 数据安全/反垄断/环保/ESG/行业准入最新动态\n\n'
        '## 十、风险与机遇\n'
        '- 用表格: | 类型 | 事项 | 影响力(1-10) | 概率 | 预估财务影响 | 建议行动 | 时限 |\n\n'
        '## 十一、下周关注\n'
        '- 即将发布的政策/数据/会议，需提前准备的合规/经营事项\n\n'
        '## 十二、高管行动矩阵\n'
        '- CEO/CFO/CMO/CSO各1-2条本周关键行动（含具体对接人/部门+时限）\n\n'
        '要求：中文，3000-5000字，每条分析有因果链+量化数据+国际对标。')

    provider_order = profile.get('ai_provider_order') if profile else None
    custom_keys = profile.get('ai_custom_keys') if profile else None

    ai_summary = call_ai('\n'.join(parts),
                         system_prompt=REPORT_SYSTEM_WEEKLY,
                         max_tokens=8000,
                         provider_order=provider_order,
                         custom_keys=custom_keys)

    report = {
        'type': 'weekly',
        'period': f'{week_ago.isoformat()} ~ {today.isoformat()}',
        'generated_at': datetime.now().isoformat(),
        'user_id': user_id,
        'company_name': company_name,
        'industries': industries,
        'sections': {
            'policy_review': {
                'total': len(policies),
                'relevant': len(relevant_policies),
                'top_items': [{'title': p.get('title',''), 'date': p.get('date',''),
                              'source': p.get('source',''), 'score': p.get('_relevance_score',0)}
                             for p in relevant_policies[:10]],
            },
            'sentiment': {
                'distribution': dist,
                'top_keywords': [k.get('word','') for k in keywords[:15]],
            },
            'cross_signals': [{
                'pattern': s.get('pattern', ''),
                'sector': s.get('sector', ''),
                'direction': s.get('direction', ''),
                'confidence': s.get('confidence', 0),
                'description': s.get('description', ''),
            } for s in data.get('cross_signals', [])[:6]],
        },
        'ai_summary': ai_summary or '报告生成中，请稍后重试。',
    }

    # Archive
    try:
        from services.report_archive import archive_report
        archive_report(user_id or 'global', 'weekly', report,
                       summary=(ai_summary or '')[:200])
    except Exception as e:
        logger.debug(f'Archive weekly report error: {e}')

    cache_set(cache_key, report, 3600)
    _release_report_lock(cache_key)
    return report


def generate_monthly_report(user_id: str = None) -> dict:
    """Generate monthly strategic report — 12 dimensions + scenario analysis + CEO decision list."""
    from services.cache import cache_get, cache_set
    from services.ai_analysis import call_ai
    from services import policy_store

    cache_key = f'cn:enterprise:monthly:{user_id}' if user_id else 'cn:enterprise:monthly:global'
    cached = cache_get(cache_key)
    if cached:
        return cached
    lock_acquired = _acquire_report_lock(cache_key)
    if lock_acquired is False:
        result = _wait_for_cache(cache_key, timeout=90)
        if result is not None:
            return result

    today = date.today()
    month_ago = today - timedelta(days=30)

    # ── 1. Policies ────────────────────────────────────────────────
    policies = policy_store.get_items_by_date_range(
        month_ago.isoformat(), today.isoformat(), limit=500)

    # Date trend
    date_counts = {}
    for p in policies:
        d = p.get('date', '')
        if d:
            date_counts[d] = date_counts.get(d, 0) + 1

    # ── 2. Profile ─────────────────────────────────────────────────
    profile = None
    if user_id:
        from services.user_profile import get_profile
        profile = get_profile(user_id)

    profile_ctx = _build_profile_context(user_id)

    # Filter policies for user
    relevant_count = len(policies)
    if profile:
        from services.relevance_scorer import filter_items_for_user
        relevant = filter_items_for_user(policies, profile, min_relevance=0.15)
        relevant_count = len(relevant)

    # ── 3. Comprehensive data ──────────────────────────────────────
    data = _gather_all_data(user_id, profile)

    # ── 4. Build prompt ────────────────────────────────────────────
    parts = [
        f'生成企业月度情报报告 ({month_ago.isoformat()} ~ {today.isoformat()}):',
        profile_ctx,
        f'\n本月政策总量: {len(policies)}条, 企业相关: {relevant_count}条, 日均: {len(policies)/30:.1f}条',
    ]
    parts.extend(_data_to_prompt_lines(data))
    parts.append(
        '\n请用Markdown格式输出完整企业月度情报（国际投行+BCG战略咨询水准），包含12个章节:\n'
        '## 一、月度宏观经济全景\n'
        '- GDP先行指标/CPI-PPI剪刀差/信贷脉冲/PMI结构/就业，明确经济周期位置\n\n'
        '## 二、财政-货币政策联动\n'
        '- 财政发力方向+货币配合节奏+政策效果评估\n\n'
        '## 三、月度政策回顾\n'
        '- 本月最重要的5-8条政策，分析: 政策→行业→企业影响链\n\n'
        '## 四、产业景气跟踪\n'
        '- 月度行业核心指标(产量/销量/价格/库存/订单/开工率)趋势，环比/同比变化\n\n'
        '## 五、供应链月度变化\n'
        '- 上下游价格传导、供需缺口、库存天数变化、关键原材料走势\n\n'
        '## 六、竞争格局演变\n'
        '- 月度市场份额变化、竞对重大动作(投融资/新品/组织调整)\n\n'
        '## 七、国际形势月度回顾\n'
        '- 中美关系/贸易数据/汇率变动/大宗商品/地缘风险事件影响评估\n\n'
        '## 八、合规风险月报\n'
        '- 新增监管政策/执法案例/合规要求变化/行业准入门槛变化\n\n'
        '## 九、供应链与产业链月报\n'
        '- 上下游价格趋势/库存变化/替代品评估/新供应商筛选\n\n'
        '## 十、情景分析\n'
        '- 乐观/基准/悲观三情景下的企业经营影响推演\n\n'
        '## 十一、战略建议与下月展望\n'
        '- 可执行建议(标注负责部门+时限) + 下月关键事件预判\n\n'
        '## 十二、CEO月度决策清单\n'
        '- 5-8条可执行决策建议，每条含负责人+deadline+预期效果\n\n'
        '要求：4000-6000字，每章结论用"■ 核心判断"总结。有因果链+量化数据。')

    provider_order = profile.get('ai_provider_order') if profile else None
    custom_keys = profile.get('ai_custom_keys') if profile else None
    ai_summary = call_ai('\n'.join(parts),
                         system_prompt=REPORT_SYSTEM_MONTHLY,
                         max_tokens=10000,
                         provider_order=provider_order,
                         custom_keys=custom_keys)

    report = {
        'type': 'monthly',
        'period': f'{month_ago.isoformat()} ~ {today.isoformat()}',
        'generated_at': datetime.now().isoformat(),
        'user_id': user_id,
        'total_policies': len(policies),
        'daily_trend': [{'date': d, 'count': c} for d, c in sorted(date_counts.items())],
        'ai_summary': ai_summary or '报告生成失败。',
    }

    # Archive
    try:
        from services.report_archive import archive_report
        archive_report(user_id or 'global', 'monthly', report,
                       summary=(ai_summary or '')[:200])
    except Exception as e:
        logger.debug(f'Archive monthly report error: {e}')

    cache_set(cache_key, report, 21600)  # 6h
    _release_report_lock(cache_key)
    return report


def generate_daily_report(user_id: str = None) -> dict:
    """Generate a daily intelligence briefing — 8 dimensions, 券商研究所 level."""
    from services.cache import cache_get, cache_set, is_trading_time
    from services.ai_analysis import call_ai
    from services import policy_store

    cache_key = f'cn:enterprise:daily:{user_id}' if user_id else 'cn:enterprise:daily:global'
    cached = cache_get(cache_key)
    if cached:
        return cached
    lock_acquired = _acquire_report_lock(cache_key)
    if lock_acquired is False:
        result = _wait_for_cache(cache_key, timeout=60)
        if result is not None:
            return result

    today = date.today()
    yesterday = today - timedelta(days=1)

    # ── 1. Policies ────────────────────────────────────────────────
    policies = policy_store.get_items_by_date_range(
        yesterday.isoformat(), today.isoformat(), limit=200)

    profile = None
    relevant_policies = policies
    if user_id:
        from services.user_profile import get_profile
        profile = get_profile(user_id)
        if profile:
            from services.relevance_scorer import filter_items_for_user
            relevant_policies = filter_items_for_user(policies, profile, min_relevance=0.2)

    profile_ctx = _build_profile_context(user_id)

    # ── 2. Comprehensive data ──────────────────────────────────────
    data = _gather_all_data(user_id, profile)

    # ── 3. Build prompt ────────────────────────────────────────────
    policy_text = '\n'.join(
        f'- {p.get("title","")} ({p.get("source","")}, 相关度:{p.get("_relevance_score",0):.2f})'
        for p in relevant_policies[:10])

    parts = [
        f'生成企业每日政策速览 ({today.isoformat()}):',
        profile_ctx,
        f'\n━━ 今日政策({len(relevant_policies)}条相关 / {len(policies)}条总计) ━━',
        policy_text or '暂无新政策',
    ]
    parts.extend(_data_to_prompt_lines(data, compact=True))
    parts.append(
        '\n请用Markdown输出高质量每日情报（券商研究所首席分析师水准），包含8个章节:\n'
        '## 一、今日宏观定位\n'
        '- 当日宏观经济数据/会议/讲话对行业的传导，标注量化数据\n\n'
        '## 二、今日政策速览\n'
        '- 3-5条最重要政策，每条: 政策内容→行业效应→企业影响(因果链)\n\n'
        '## 三、财政/货币动向\n'
        '- 当日MLF/逆回购/专项债/补贴对企业融资成本的影响\n\n'
        '## 四、产业链与竞争视角\n'
        '- 政策在上中下游传导差异 + 对企业vs竞对的差异化影响\n\n'
        '## 五、国际联动\n'
        '- 当日汇率/大宗商品/地缘/贸易事件对企业的影响\n\n'
        '## 六、今日行动建议\n'
        '- 3条可立即执行建议，标注紧急程度+负责部门\n\n'
        '## 七、供应链预警\n'
        '- 上游原材料价格变化(含具体涨跌幅度) + 替代方案评估\n\n'
        '## 八、CEO今日行动清单\n'
        '- 3-5条具体行动：做什么 + 找谁 + 何时完成 + 预期效果\n\n'
        '要求：1500-2000字，每条分析有因果链(A→B→C)和量化锚点。')

    provider_order = profile.get('ai_provider_order') if profile else None
    custom_keys = profile.get('ai_custom_keys') if profile else None
    ai_summary = call_ai('\n'.join(parts),
                         system_prompt=REPORT_SYSTEM_DAILY,
                         max_tokens=3500,
                         provider_order=provider_order,
                         custom_keys=custom_keys)

    report = {
        'type': 'daily',
        'period': today.isoformat(),
        'generated_at': datetime.now().isoformat(),
        'user_id': user_id,
        'total_policies': len(relevant_policies),
        'ai_summary': ai_summary or '日报生成失败。',
    }

    # Archive
    try:
        from services.report_archive import archive_report
        archive_report(user_id or 'global', 'daily', report,
                       summary=(ai_summary or '')[:200])
    except Exception as e:
        logger.debug(f'Archive daily report error: {e}')

    ttl = 14400 if is_trading_time() else 43200
    cache_set(cache_key, report, ttl)
    _release_report_lock(cache_key)
    return report


def generate_quarterly_report(user_id: str = None) -> dict:
    """Generate quarterly strategic report — 10 dimensions + scenario analysis."""
    from services.cache import cache_get, cache_set
    from services.ai_analysis import call_ai
    from services import policy_store

    cache_key = f'cn:enterprise:quarterly:{user_id}' if user_id else 'cn:enterprise:quarterly:global'
    cached = cache_get(cache_key)
    if cached:
        return cached
    lock_acquired = _acquire_report_lock(cache_key)
    if lock_acquired is False:
        result = _wait_for_cache(cache_key, timeout=90)
        if result is not None:
            return result

    today = date.today()
    quarter_ago = today - timedelta(days=90)

    # ── 1. Policies ────────────────────────────────────────────────
    policies = policy_store.get_items_by_date_range(
        quarter_ago.isoformat(), today.isoformat(), limit=1000)

    # Monthly trend
    month_counts = {}
    for p in policies:
        d = p.get('date', '')
        if d and len(d) >= 7:
            month_key = d[:7]
            month_counts[month_key] = month_counts.get(month_key, 0) + 1

    # ── 2. Profile & data ──────────────────────────────────────────
    profile = None
    if user_id:
        from services.user_profile import get_profile
        profile = get_profile(user_id)

    profile_ctx = _build_profile_context(user_id)
    data = _gather_all_data(user_id, profile)

    # ── 3. Build prompt ────────────────────────────────────────────
    parts = [
        f'生成企业季度战略情报报告 ({quarter_ago.isoformat()} ~ {today.isoformat()}):',
        profile_ctx,
        f'\n本季度政策总量: {len(policies)}条',
        f'月度分布: {", ".join(f"{m}:{c}条" for m,c in sorted(month_counts.items()))}',
    ]
    parts.extend(_data_to_prompt_lines(data))
    parts.append(
        '\n请用Markdown格式输出企业季度战略情报（McKinsey/BCG季度战略回顾水准），包含10个章节:\n'
        '## 一、季度宏观经济\n'
        '- 季度GDP增速/通胀/就业/贸易回顾，经济周期阶段判断，与前季环比趋势\n\n'
        '## 二、财政政策季度评估\n'
        '- 专项债发行进度/减税降费落地/产业补贴到位情况/地方债务风险\n\n'
        '## 三、货币政策季度环境\n'
        '- 利率走廊变化/信贷投放结构/社融增速/M2-M1剪刀差，流动性影响\n\n'
        '## 四、产业周期评估\n'
        '- 产能利用率变化/库存周期位置/资本开支变化/行业盈利能力趋势\n\n'
        '## 五、竞争格局\n'
        '- 季度CR3/CR5变化、重大并购/融资/IPO、竞对季报关键指标对比\n\n'
        '## 六、供应链风险评估\n'
        '- 关键原材料价格趋势/供应集中度/替代方案成熟度/物流成本变化\n\n'
        '## 七、国际形势\n'
        '- 中美关系/贸易数据/汇率波动/大宗商品超级周期/地缘冲突演变\n\n'
        '## 八、监管与合规趋势\n'
        '- 新法规/执法力度/行业整改/数据安全/ESG要求升级\n\n'
        '## 九、情景分析\n'
        '- 乐观/基准/悲观三情景及触发条件，企业经营影响推演\n\n'
        '## 十、战略建议\n'
        '- 分短期(1-3月)/中期(3-12月)/长期(1-3年)，标注优先级\n'
        '- 下季度关键决策时点和行动计划\n\n'
        '要求：4000-5000字，每章用"■ 季度核心判断"开头。量化对比：本季vs上季/去年同期(%+绝对值)。')

    provider_order = profile.get('ai_provider_order') if profile else None
    custom_keys = profile.get('ai_custom_keys') if profile else None
    ai_summary = call_ai('\n'.join(parts),
                         system_prompt=REPORT_SYSTEM_QUARTERLY,
                         max_tokens=8000,
                         provider_order=provider_order,
                         custom_keys=custom_keys)

    report = {
        'type': 'quarterly',
        'period': f'{quarter_ago.isoformat()} ~ {today.isoformat()}',
        'generated_at': datetime.now().isoformat(),
        'user_id': user_id,
        'total_policies': len(policies),
        'monthly_trend': [{'month': m, 'count': c} for m, c in sorted(month_counts.items())],
        'ai_summary': ai_summary or '季报生成失败。',
    }

    # Archive
    try:
        from services.report_archive import archive_report
        archive_report(user_id or 'global', 'quarterly', report,
                       summary=(ai_summary or '')[:200])
    except Exception as e:
        logger.debug(f'Archive quarterly report error: {e}')

    cache_set(cache_key, report, 21600)  # 6h
    _release_report_lock(cache_key)
    return report


def generate_annual_report(user_id: str = None) -> dict:
    """Generate annual strategic review — 11 dimensions + outlook + scenario planning."""
    from services.cache import cache_get, cache_set
    from services.ai_analysis import call_ai
    from services import policy_store

    cache_key = f'cn:enterprise:annual:{user_id}' if user_id else 'cn:enterprise:annual:global'
    cached = cache_get(cache_key)
    if cached:
        return cached
    lock_acquired = _acquire_report_lock(cache_key, timeout=120)
    if lock_acquired is False:
        result = _wait_for_cache(cache_key, timeout=120)
        if result is not None:
            return result

    today = date.today()
    year_ago = today - timedelta(days=365)

    # ── 1. Policies ────────────────────────────────────────────────
    policies = policy_store.get_items_by_date_range(
        year_ago.isoformat(), today.isoformat(), limit=2000)

    # Monthly trend
    month_counts = {}
    for p in policies:
        d = p.get('date', '')
        if d and len(d) >= 7:
            month_key = d[:7]
            month_counts[month_key] = month_counts.get(month_key, 0) + 1

    # Quarterly aggregation
    quarter_counts = {}
    for m, c in month_counts.items():
        q = f'{m[:4]}Q{(int(m[5:7])-1)//3+1}'
        quarter_counts[q] = quarter_counts.get(q, 0) + c

    # ── 2. Profile & data ──────────────────────────────────────────
    profile = None
    if user_id:
        from services.user_profile import get_profile
        profile = get_profile(user_id)

    profile_ctx = _build_profile_context(user_id)
    data = _gather_all_data(user_id, profile)

    # ── 3. Build prompt ────────────────────────────────────────────
    parts = [
        f'生成企业年度战略回顾报告 ({year_ago.isoformat()} ~ {today.isoformat()}):',
        profile_ctx,
        f'\n年度政策总量: {len(policies)}条',
        f'季度分布: {", ".join(f"{q}:{c}条" for q,c in sorted(quarter_counts.items()))}',
    ]
    parts.extend(_data_to_prompt_lines(data))
    parts.append(
        '\n请用Markdown格式输出年度战略回顾（McKinsey年度战略回顾+高盛全球宏观年报水准），包含11个章节:\n'
        '## 一、全年宏观回顾\n'
        '- 年度GDP/CPI/PPI/PMI/就业/贸易全景，经济周期定位与转折点，与十四五目标对照\n\n'
        '## 二、财政政策年度\n'
        '- 赤字率/专项债规模/减税降费效果/产业政策导向/地方债风险化解\n\n'
        '## 三、货币政策年度\n'
        '- 降准降息节奏/信贷结构优化/汇率管理/跨境资本流动\n\n'
        '## 四、产业全景\n'
        '- 市场规模/增速/渗透率/技术路线演进/产能周期/行业盈利周期\n\n'
        '## 五、竞争格局年变\n'
        '- CR3/CR5年度变化/重大并购/上市公司年报对比/战略转型案例\n\n'
        '## 六、国际形势年度\n'
        '- 中美关系全年演变/全球供应链重构/RCEP实施/汇率年度波动/地缘冲突\n\n'
        '## 七、区域经济年度\n'
        '- 各重点区域发展差异：产业集群/区域竞争力/人才流动/产业转移\n\n'
        '## 八、技术演进年度\n'
        '- 关键技术突破/国产替代里程碑/新标准/专利格局/AI渗透\n\n'
        '## 九、监管年度回顾\n'
        '- 重大法规/执法案例/合规成本/ESG要求/数据安全\n\n'
        '## 十、来年展望\n'
        '- 宏观预判(GDP/CPI/利率/汇率区间)\n'
        '- 行业预判(景气度/产能/库存/价格)\n'
        '- 政策预判(财政/货币/产业方向)\n\n'
        '## 十一、战略建议与情景规划\n'
        '- 来年战略重点(3-5个)，分优先级\n'
        '- 12个月关键决策时点和行动计划\n'
        '- 乐观(30%)/基准(50%)/悲观(20%)三情景经营策略\n\n'
        '要求：5000-7000字，具备CEO年度战略汇报深度。每章用"■ 年度核心判断"开头。量化对比有年度同比+趋势判断。')

    provider_order = profile.get('ai_provider_order') if profile else None
    custom_keys = profile.get('ai_custom_keys') if profile else None
    ai_summary = call_ai('\n'.join(parts),
                         system_prompt=REPORT_SYSTEM_ANNUAL,
                         max_tokens=10000,
                         provider_order=provider_order,
                         custom_keys=custom_keys)

    report = {
        'type': 'annual',
        'period': f'{year_ago.isoformat()} ~ {today.isoformat()}',
        'generated_at': datetime.now().isoformat(),
        'user_id': user_id,
        'total_policies': len(policies),
        'monthly_trend': [{'month': m, 'count': c} for m, c in sorted(month_counts.items())],
        'quarterly_trend': [{'quarter': q, 'count': c} for q, c in sorted(quarter_counts.items())],
        'ai_summary': ai_summary or '年报生成失败。',
    }

    # Archive
    try:
        from services.report_archive import archive_report
        archive_report(user_id or 'global', 'annual', report,
                       summary=(ai_summary or '')[:200])
    except Exception as e:
        logger.debug(f'Archive annual report error: {e}')

    cache_set(cache_key, report, 86400)  # 24h
    _release_report_lock(cache_key)
    return report


# ── Profile & utility functions ──────────────────────────────────────────────

def _build_profile_context(user_id: str = None) -> str:
    """Build enriched profile context string for AI prompts."""
    if not user_id:
        return ''
    from services.user_profile import get_profile
    profile = get_profile(user_id)
    if not profile:
        return ''

    parts = []
    if profile.get('company_name'):
        parts.append(f'服务企业: {profile["company_name"]}')
    if profile.get('business_scope'):
        parts.append(f'主营业务: {profile["business_scope"]}')
    if profile.get('company_size'):
        parts.append(f'企业规模: {profile["company_size"]}')
    if profile.get('industries'):
        parts.append(f'所在行业: {", ".join(profile["industries"])}')
    if profile.get('supply_chain_up'):
        parts.append(f'上游供应链: {", ".join(profile["supply_chain_up"])}')
    if profile.get('supply_chain_down'):
        parts.append(f'下游客户/渠道: {", ".join(profile["supply_chain_down"])}')
    if profile.get('competitors'):
        parts.append(f'主要竞争对手: {", ".join(profile["competitors"])}')
    if profile.get('compliance_concerns'):
        parts.append(f'合规关注点: {", ".join(profile["compliance_concerns"])}')
    if profile.get('business_regions'):
        parts.append(f'经营区域: {", ".join(profile["business_regions"])}')
    return '\n'.join(parts)


def get_report_list(user_id: str = None) -> list:
    """Return list of available report types with latest generation timestamps."""
    from services.cache import cache_get

    types = [
        {'type': 'daily', 'label': '日报', 'description': '每日政策速览与行动建议'},
        {'type': 'weekly', 'label': '周报', 'description': '周度情报简报与经营建议'},
        {'type': 'monthly', 'label': '月报', 'description': '月度趋势分析与战略建议'},
        {'type': 'quarterly', 'label': '季报', 'description': '季度战略情报与竞争格局'},
        {'type': 'annual', 'label': '年报', 'description': '年度回顾与战略规划'},
    ]

    for t in types:
        cache_key = f'cn:enterprise:{t["type"]}:{user_id}' if user_id else f'cn:enterprise:{t["type"]}:global'
        cached = cache_get(cache_key)
        if cached:
            t['generated_at'] = cached.get('generated_at', '')
            t['available'] = True
        else:
            t['generated_at'] = None
            t['available'] = False

    return types


def _markdown_to_html(text: str) -> str:
    """Convert markdown to HTML for export. Uses regex-based conversion to avoid extra dependencies."""
    import re
    if not text:
        return ''
    html = text
    # Headers: ## title → <h2>title</h2>
    html = re.sub(r'^### (.+)$', r'<h3>\1</h3>', html, flags=re.MULTILINE)
    html = re.sub(r'^## (.+)$', r'<h2>\1</h2>', html, flags=re.MULTILINE)
    html = re.sub(r'^# (.+)$', r'<h1>\1</h1>', html, flags=re.MULTILINE)
    # Bold: **text** → <strong>text</strong>
    html = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', html)
    # Italic: *text* → <em>text</em>
    html = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<em>\1</em>', html)
    # Bullet lists: - item → <li>item</li>
    html = re.sub(r'^- (.+)$', r'<li>\1</li>', html, flags=re.MULTILINE)
    # Wrap consecutive <li> in <ul>
    html = re.sub(r'((?:<li>.*?</li>\n?)+)', r'<ul>\1</ul>', html)
    # Tables: | col | col | → <table>
    lines = html.split('\n')
    result = []
    in_table = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('|') and stripped.endswith('|'):
            cells = [c.strip() for c in stripped.strip('|').split('|')]
            if all(set(c) <= {'-', ':', ' '} for c in cells):
                continue  # separator row
            if not in_table:
                result.append('<table style="width:100%;border-collapse:collapse;margin:8px 0">')
                tag = 'th'
                in_table = True
            else:
                tag = 'td'
            row = ''.join(f'<{tag} style="padding:6px 10px;border:1px solid #ddd;text-align:left">{c}</{tag}>' for c in cells)
            result.append(f'<tr>{row}</tr>')
        else:
            if in_table:
                result.append('</table>')
                in_table = False
            result.append(line)
    if in_table:
        result.append('</table>')
    html = '\n'.join(result)
    # Paragraphs: double newline → <p>
    html = re.sub(r'\n{2,}', '</p><p>', html)
    html = html.replace('\n', '<br>')
    html = f'<p>{html}</p>'
    return html


def export_to_html(report: dict) -> str:
    """Convert a report dict to printable HTML."""
    report_type = report.get('type', 'weekly')
    period = report.get('period', '')
    summary = report.get('ai_summary', '')

    # Convert markdown to HTML
    html_summary = _markdown_to_html(summary)

    company_name = report.get('company_name', '')
    industries = report.get('industries', [])

    sections = report.get('sections', {})
    policy_section = sections.get('policy_review', {})
    top_policies = policy_section.get('top_items', [])

    policy_rows = ''.join(
        f'<tr><td>{p.get("date","")}</td><td>{p.get("title","")}</td>'
        f'<td>{p.get("source","")}</td></tr>'
        for p in top_policies[:10]
    )

    signals = sections.get('cross_signals', [])
    signal_rows = ''.join(
        f'<tr><td>{s.get("pattern","")}</td><td>{s.get("sector","")}</td>'
        f'<td>{s.get("direction","")}</td><td>{s.get("description","")}</td></tr>'
        for s in signals[:6]
    )

    company_line = f' — {company_name}' if company_name else ''
    industry_line = f'<p style="color:#666;font-size:13px">行业: {", ".join(industries)}</p>' if industries else ''

    type_labels = {'daily': '日报', 'weekly': '周报', 'monthly': '月报',
                   'quarterly': '季报', 'annual': '年报'}
    type_label = type_labels.get(report_type, '情报报告')

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>企业{type_label}{company_line} - {period}</title>
<style>
  body {{ font-family: -apple-system, 'PingFang SC', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333; }}
  h1 {{ color: #1a237e; border-bottom: 2px solid #e8a838; padding-bottom: 8px; }}
  h2 {{ color: #37474f; margin-top: 24px; }}
  table {{ width: 100%; border-collapse: collapse; margin: 12px 0; }}
  th, td {{ padding: 8px 12px; border: 1px solid #e0e0e0; text-align: left; font-size: 13px; }}
  th {{ background: #f5f5f5; font-weight: 600; }}
  .summary {{ line-height: 1.8; font-size: 14px; }}
  .footer {{ margin-top: 30px; padding-top: 10px; border-top: 1px solid #eee; font-size: 11px; color: #999; }}
  @media print {{ body {{ max-width: 100%; }} }}
</style>
</head>
<body>
<h1>企业{type_label}{company_line}</h1>
<p style="color:#888">{period} | 生成时间: {report.get('generated_at','')}</p>
{industry_line}

<div class="summary">{html_summary}</div>

<h2>重点政策</h2>
<table>
<tr><th>日期</th><th>标题</th><th>来源</th></tr>
{policy_rows}
</table>

<h2>跨域关联信号</h2>
<table>
<tr><th>模式</th><th>板块</th><th>方向</th><th>说明</th></tr>
{signal_rows}
</table>

<div class="footer">
  Powered by World Monitor 企业情报引擎 | cn-intel-service
</div>
</body>
</html>"""


def check_scheduled_reports():
    """Check if any users have scheduled reports due.
    Called periodically from report_scheduler loop."""
    from services.user_profile import get_all_profiles

    profiles = get_all_profiles()
    today = date.today()

    for profile in profiles:
        user_id = profile.get('user_id', '')
        if not user_id:
            continue

        freq = profile.get('report_frequency', 'weekly')

        # Daily: generate every trading day (for users with daily or weekly frequency)
        if freq == 'daily' and today.weekday() < 5:
            try:
                generate_daily_report(user_id)
                logger.warning(f'[enterprise] Generated daily report for {user_id[:8]}...')
            except Exception as e:
                logger.warning(f'[enterprise] Daily report error for {user_id[:8]}...: {e}')

        # Weekly: generate on Monday
        if today.weekday() == 0:  # Monday
            try:
                generate_weekly_report(user_id)
                logger.warning(f'[enterprise] Generated weekly report for {user_id[:8]}...')
            except Exception as e:
                logger.warning(f'[enterprise] Weekly report error for {user_id[:8]}...: {e}')

        # Monthly: generate on 1st
        if today.day == 1:
            try:
                generate_monthly_report(user_id)
                logger.warning(f'[enterprise] Generated monthly report for {user_id[:8]}...')
            except Exception as e:
                logger.warning(f'[enterprise] Monthly report error for {user_id[:8]}...: {e}')

            # Quarterly: generate on 1st of Jan/Apr/Jul/Oct
            if today.month in (1, 4, 7, 10):
                try:
                    generate_quarterly_report(user_id)
                    logger.warning(f'[enterprise] Generated quarterly report for {user_id[:8]}...')
                except Exception as e:
                    logger.warning(f'[enterprise] Quarterly report error for {user_id[:8]}...: {e}')

            # Annual: generate on Jan 1st
            if today.month == 1:
                try:
                    generate_annual_report(user_id)
                    logger.warning(f'[enterprise] Generated annual report for {user_id[:8]}...')
                except Exception as e:
                    logger.warning(f'[enterprise] Annual report error for {user_id[:8]}...: {e}')
