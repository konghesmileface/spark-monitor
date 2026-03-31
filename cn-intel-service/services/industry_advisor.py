"""Industry Advisor — AI-powered industry consulting engine.

Transforms raw policy + sentiment + market data into actionable
business advice from an industry/consulting perspective (not trading).
"""

import hashlib
import json
import logging
from datetime import datetime, timedelta

from config import Config
from services.ai_analysis import call_ai
from services.cache import cache_get, cache_set, is_trading_time
from services.cross_domain_engine import build_correlation_context, detect_cross_signals
from services.data_provider import get_north_flow, get_sector_rank, get_macro_indicators, get_margin_data
from services.global_signals import build_global_signal_context
from services.global_data_feeds import build_global_data_context
from services.policy_store import get_items_by_date_range
from services.relevance_scorer import filter_items_for_user
from services.user_profile import get_profile, get_expanded_sectors

logger = logging.getLogger('cn-intel.industry-advisor')

# ── System prompt — the core differentiator ──────────────────────────────────

INDUSTRY_SYSTEM_PROMPT = """你是一位对标券商研究所首席行业分析师的资深产业顾问，直接服务于中国企业CEO/COO。你的产业洞察报告的分析深度和专业性要超越券商卖方研究。

━━ 分析框架（全维度产业研究）━━

【宏观-中观传导】宏观政策(财政/货币)如何传导到本行业——利率变化→融资成本→资本开支→产能扩张/收缩链条。PMI分项(新订单/产成品库存/原材料库存)对行业景气的领先指示
【产业周期定位】行业处于导入期/成长期/成熟期/衰退期的哪个阶段。产能周期(扩产/出清/再平衡)、库存周期(主动补库/被动补库/主动去库/被动去库)、资本开支周期
【产业链深度】上游(原材料/零部件/设备)→中游(制造/加工/集成)→下游(品牌/渠道/终端/消费者)：各环节议价能力、利润分配、供需缺口。分析政策在产业链上的传导速度和衰减
【竞争格局分析】Porter五力模型：行业集中度CR3/CR5/HHI变化趋势、竞对战略(并购/扩产/出海/转型)、新进入者壁垒(资金/技术/牌照/渠道)、替代品威胁(技术替代/品类替代)
【区域产业集群】重点产业集群分布(如新能源→常州/合肥、半导体→上海/南京/成都)、区域政策差异(税收优惠/用地/人才)、产业转移趋势(东部→中西部、国内→东南亚)
【国际对标与竞争】同一行业在美/欧/日/韩/东南亚的发展阶段对标。政策方向的国际先例和效果(如碳中和/数据安全/反垄断的他国经验)。中美技术脱钩/友岸外包对产业链的重构影响
【财政与产业政策】专项补贴/产业基金/政府采购/税收优惠/出口退税/碳交易等对行业利润的直接量化影响
【技术路线演进】技术迭代路线图(如锂电→固态电池→钠离子)、国产替代进度、标准制定(国标/行标)对竞争格局的影响
【监管环境】行业准入/退出机制变化、安全生产/环保/ESG/数据合规趋势、反垄断执法动向

━━ 核心原则 ━━
1. 企业视角第一 — 每条分析必须回答"对贵司具体意味着什么"，用营收/利润/份额/成本等企业经营指标表述
2. 因果链推演 — 政策A→行业效应B→企业影响C→建议行动D，不止一阶
3. 量化锚定 — 引用具体数据(行业增速/渗透率/产能利用率/库存天数/毛利率变化)
4. 国际参照 — 同类政策/趋势在海外的先例效果
5. 产业链视角 — 分析上中下游差异化影响
6. 时间锚定 — 每条建议给出行动截止日或关键时间节点

输出要求（必须返回合法JSON，不要markdown代码块）：
{
  "headline": "一句话概括产业核心变化(≤30字)，融合宏观+产业+企业三层判断",
  "risk_level": "low|moderate|elevated|high|critical",
  "risk_label": "低|适中|偏高|高|严峻",
  "industry_health_score": 0-100(行业景气度，参考PMI/产能利用率/库存/订单综合判断),
  "industry_health_label": "景气|平稳|承压|衰退",
  "industry_cycle": {
    "stage": "导入期|成长期|成熟期|衰退期",
    "capacity_cycle": "扩产|出清|再平衡",
    "inventory_cycle": "主动补库|被动补库|主动去库|被动去库",
    "summary": "产业周期定位一句话判断"
  },
  "key_developments": [
    {
      "title": "动态标题",
      "source": "来源",
      "date": "日期",
      "urgency": "urgent|important|watch",
      "urgency_label": "紧急|重要|关注",
      "impact_summary": "影响概述(2-3句)：因果链推演+量化影响",
      "business_impact": "对贵司的具体影响(2句)：营收/成本/份额维度，引用量化数据",
      "action_deadline": "建议行动截止日(如'2026-04-01前')",
      "recommended_actions": ["具体可执行建议(含对接部门/对象)"],
      "affected_areas": ["供应链", "成本", "合规"],
      "transmission_chain": "政策传导路径(如'补贴→扩产→价格战→中小企业出清')"
    }
  ],
  "trend_signals": [
    {"signal": "趋势信号(≤20字，含量化数据)", "direction": "positive|negative|neutral", "strength": 1-5, "data_point": "支撑数据(必须包含具体数字，如'PMI新订单52.3，环比+0.8pp'或'开工率78.5%，同比-3.2pp')"}
  ],
  "macro_industry_linkage": "宏观-产业联动分析(2-3句)：财政/货币政策如何影响本行业的融资/投资/需求",
  "outlook": {
    "summary": "1-4周产业展望(3-4句)，包含景气度/产能/库存/政策窗口的判断",
    "timeframe": "1-4周",
    "key_dates": ["重要日期及事件(含具体日期和预期影响)"],
    "scenario_analysis": "情景分析：乐观/基准/悲观三种情形简述"
  },
  "next_week_watchlist": ["下周关注(含具体指标/事件+预期值+影响判断)"],
  "risks": [{"description": "风险描述(2句，含量化损失预估和概率判断)", "severity": "高|中|低", "category": "政策|竞争|供应链|合规|技术|国际", "trigger": "触发条件"}],
  "opportunities": [{"description": "机会描述(2句，含量化收益预估和可行性判断)", "potential": "高|中|低", "category": "政策红利|技术升级|市场准入|并购整合|出海扩张", "window": "窗口期"}],
  "international_context": "国际对标(2-3句)：同行业海外发展经验/先例+中美竞争格局+全球供应链重构影响",
  "supply_chain_map": {
    "upstream": "上游分析(含原材料价格具体数字+涨跌幅，如'碳酸锂8.5万/吨↓12%'+议价能力变化)",
    "midstream": "中游分析(含产能利用率具体数字，如'行业开工率78%↑3pp'+库存变化)",
    "downstream": "下游分析(含终端需求具体数据，如'新能源车渗透率42%↑5pp'+消费趋势)"
  },
  "competitive_dynamics": {
    "summary": "竞争格局变化总结(2-3句)",
    "cr3_cr5": "CR3/CR5具体数值或趋势(如'CR3约45%，较上季+2pp')",
    "top_competitors": [{"name": "公司全称", "market_cap_or_revenue": "市值或营收(如'市值850亿')", "recent_move": "最近动作(≤30字)", "threat_level": "high|medium|low"}],
    "new_entrants": "新进入者信息(公司名+背景+威胁)或null",
    "exit_players": "退出者信息(公司名+原因)或null"
  },
  "executive_lens": {
    "ceo_view": "CEO视角：战略层面的产业判断+资源配置建议(2-3句，含具体公司名/数据)",
    "cmo_view": "CMO视角：市场竞争态势+客户/渠道变化+品牌策略调整(2-3句，含市场份额或客户数据)",
    "cfo_view": "CFO视角：行业估值变化+融资环境+成本结构影响+现金流建议(2-3句，含量化数字)",
    "cso_view": "CSO视角：中长期产业格局演变+技术路线选择+战略卡位建议(2-3句，含竞对分析)"
  },
  "time_horizon": {
    "near_term": "近期(1-4周)：最紧迫的行业变化和需要立即响应的事项(3-4句，含具体日期和行动项)",
    "mid_term": "中期(1-3个季度)：正在酝酿的趋势拐点和需要提前部署的事项(3-4句，含里程碑节点)",
    "long_term": "远期(1-3年)：结构性变化和战略机遇/威胁(2-3句，含产业终局判断)"
  }
}

key_developments最多6条，trend_signals最多5条，risks和opportunities各最多4条，next_week_watchlist最多4条。
business_impact和transmission_chain是产业洞察最核心的字段——必须体现券商研究所级别的因果链分析和量化深度。
每条分析都要有数据支撑，不接受"可能""或许""建议关注"等模糊表述。
executive_lens必须包含ceo_view/cmo_view/cfo_view/cso_view四个视角，每个视角的分析必须差异化且包含具体数据或公司名。
time_horizon必须包含near_term/mid_term/long_term三个时间维度，每个维度必须有具体的时间节点和行动建议。"""

DEEP_ANALYSIS_PROMPT = """你是一位资深产业咨询顾问。请对以下政策进行深度产业影响分析。

分析维度：
1. supply_chain: 对供应链上下游的影响
2. cost: 对企业成本结构的影响
3. competition: 对竞争格局的影响
4. regulation: 监管合规要求变化
5. recommended_actions: 3-5条具体可执行的商业建议
6. international_reference: 该政策方向在海外的先例/对比(如有,一段文字)
7. chain_position: 产业链上中下游差异化影响(一段文字)

必须返回合法JSON，不要添加markdown代码块标记。"""

RISK_LABELS = {
    'low': '低', 'moderate': '适中', 'elevated': '偏高',
    'high': '高', 'critical': '严峻',
}

URGENCY_LABELS = {
    'urgent': '紧急', 'important': '重要', 'watch': '关注',
}

AFFECTED_AREA_KEYWORDS = {
    '供应链': ['供应', '供给', '产能', '供货', '配套', '上游', '下游', '物流'],
    '成本': ['成本', '价格', '费用', '关税', '税', '补贴', '降价', '涨价'],
    '定价': ['定价', '价格', '售价', '调价'],
    '市场准入': ['准入', '许可', '资质', '牌照', '审批', '备案', '认证'],
    '竞争格局': ['竞争', '整合', '并购', '淘汰', '龙头', '集中度', '市占率'],
    '监管风险': ['监管', '合规', '处罚', '整改', '违规', '检查', '执法'],
    '技术路线': ['技术', '标准', '创新', '研发', '专利', '国产化', '自主'],
    '国际贸易': ['出口', '进口', '关税', '贸易', '制裁', '跨境', '外资'],
}


def _industry_ttl(trading_ttl: int, off_ttl: int) -> int:
    """Return TTL based on whether market is in trading hours."""
    return trading_ttl if is_trading_time() else off_ttl


def _build_market_context() -> str:
    """Fetch real market data and build context string for AI prompt."""
    parts = []
    try:
        sectors = get_sector_rank(top_n=5)
        if sectors:
            lines = [f"  {s['name']}: {s['changePercent']:+.2f}%" for s in sectors[:5]]
            parts.append('板块涨跌TOP5:\n' + '\n'.join(lines))
    except Exception as e:
        logger.debug(f'get_sector_rank failed: {e}')

    try:
        north = get_north_flow()
        if north and north.get('totalFlow', 0) != 0:
            total = north['totalFlow']
            direction = '净流入' if total > 0 else '净流出'
            parts.append(f'北向资金: {direction} {abs(total):.0f}万元')
    except Exception as e:
        logger.debug(f'get_north_flow failed: {e}')

    # Macro indicators
    try:
        macro = get_macro_indicators()
        if macro:
            macro_parts = []
            if macro.get('cpi'):
                macro_parts.append(f"CPI:{macro['cpi']}")
            if macro.get('ppi'):
                macro_parts.append(f"PPI:{macro['ppi']}")
            if macro.get('pmi'):
                macro_parts.append(f"PMI:{macro['pmi']}")
            if macro_parts:
                parts.append('宏观指标: ' + ' | '.join(macro_parts))
    except Exception as e:
        logger.debug(f'get_macro_indicators failed: {e}')

    # Margin data
    try:
        margin = get_margin_data()
        if margin and margin.get('balance'):
            line = f"融资融券余额: {margin['balance']:.0f}亿元"
            if margin.get('change'):
                line += f" (日变化{margin['change']:+.0f}亿)"
            parts.append(line)
    except Exception as e:
        logger.debug(f'get_margin_data failed: {e}')

    # Social mood
    try:
        from services.cache import cache_get as _cg
        mood = _cg('cn:mood:social') or {}
        if mood.get('distribution'):
            d = mood['distribution']
            parts.append(f"舆情: 正面{d.get('positive',0)} 负面{d.get('negative',0)} 中性{d.get('neutral',0)}")
            kws = mood.get('keywords', [])
            if kws:
                parts.append(f"热词: {', '.join(k.get('word','') for k in kws[:8])}")
    except Exception:
        pass

    return '\n'.join(parts)


def generate_industry_brief(user_id: str) -> dict:
    """Generate AI-powered industry brief for a user."""
    # 1. Check cache
    cache_key = f'cn:industry:brief:{user_id}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    # 2. Load user profile (MySQL → Redis cache fallback)
    profile = get_profile(user_id)
    if not profile or not profile.get('industries'):
        # Fallback: check Redis cache (set by profile API)
        cached_profile = cache_get(f'cn:profile:{user_id}')
        if cached_profile and cached_profile.get('industries'):
            profile = cached_profile
    # Fallback: use popular default industries when no profile
    DEFAULT_INDUSTRIES = ['新能源', '半导体', 'AI', '生物医药', '高端装备']
    if not profile or not profile.get('industries'):
        profile = {'industries': DEFAULT_INDUSTRIES}
        logger.warning('用户 %s 无行业画像，使用默认行业: %s', user_id, DEFAULT_INDUSTRIES)

    industries = profile.get('industries', [])
    sectors = get_expanded_sectors(profile)

    # 3. Gather recent policies (3 days)
    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')
    all_policies = get_items_by_date_range(start_date, end_date, limit=500)

    # 4. Filter for user relevance (with progressive fallback)
    relevant = filter_items_for_user(all_policies, profile, min_relevance=0.15)
    loose_match = False
    if not relevant:
        # Second pass: lower threshold
        relevant = filter_items_for_user(all_policies, profile, min_relevance=0.05)
        loose_match = True
    if not relevant:
        # Third pass: take latest 20 policies, let AI judge relevance
        relevant = all_policies[:20]
        loose_match = True
    if not relevant:
        return _build_empty_brief(industries, all_policies)

    # 5. Gather supplementary context
    sentiment_raw = cache_get('cn:mood:social') or {}
    overview = cache_get('cn:market:overview') or {}
    market_raw = overview.get('sectors', {}) if isinstance(overview, dict) else {}
    correlation = build_correlation_context(sectors)
    cross_signals = detect_cross_signals(correlation)

    # 6. Build AI prompt
    policy_text = '\n'.join(
        f"- [{p.get('category','')}] {p['title']} ({p.get('source','')}, {p.get('date','')})"
        for p in relevant[:20]
    )
    signal_text = '\n'.join(
        f"- [{s.get('type','')}] {s.get('summary','')}"
        for s in (cross_signals or [])[:5]
    )
    market_context = _build_market_context()

    # Enriched profile context for AI
    supply_up = profile.get('supply_chain_up', [])
    supply_down = profile.get('supply_chain_down', [])
    competitors = profile.get('competitors', [])
    compliance = profile.get('compliance_concerns', [])
    regions = profile.get('business_regions', [])
    business_scope = profile.get('business_scope', '')

    profile_lines = []
    if business_scope:
        profile_lines.append(f'主营业务: {business_scope}')
    if supply_up:
        profile_lines.append(f'上游供应链: {", ".join(supply_up[:8])}')
    if supply_down:
        profile_lines.append(f'下游客户/渠道: {", ".join(supply_down[:8])}')
    if competitors:
        profile_lines.append(f'主要竞争对手: {", ".join(competitors[:5])}')
    if compliance:
        profile_lines.append(f'合规关注点: {", ".join(compliance[:8])}')
    if regions:
        profile_lines.append(f'经营区域: {", ".join(regions[:8])}')
    profile_ctx = '\n'.join(profile_lines)

    # Global OSINT signals
    global_signal_text = ''
    try:
        global_signal_text = build_global_signal_context(user_id, max_items=5)
    except Exception as e:
        logger.debug(f'Global signals fetch failed: {e}')

    # International data feeds (RSS + Yahoo Finance + Polymarket)
    global_data_text = ''
    try:
        global_data_text = build_global_data_context(user_id, profile)
    except Exception as e:
        logger.debug(f'Global data feeds fetch failed: {e}')

    loose_hint = '\n注意：以下政策未必与用户行业直接相关（匹配度较低），请从中筛选可能相关的进行分析，无关政策可忽略。' if loose_match else ''

    # Regime detection
    regime_text = ''
    try:
        from services.cross_domain_engine import detect_regime
        regime = detect_regime()
        if regime:
            regime_text = f"市场环境: {regime.get('label', '')} — {regime.get('description', '')}"
    except Exception:
        pass

    # Policy keyword trends
    keyword_trend_text = ''
    try:
        from services.policy_signal_tracker import compute_keyword_trends
        kw_trends = compute_keyword_trends(days_back=7)
        if kw_trends:
            rising = [f"{k['keyword']}(+{k['change']}%)" for k in kw_trends if k.get('change', 0) > 0][:5]
            if rising:
                keyword_trend_text = f"政策热词趋势(7日): {', '.join(rising)}"
    except Exception:
        pass

    user_prompt = f"""━━ 企业画像 ━━
关注行业: {', '.join(industries)}
相关板块: {', '.join(sectors[:10])}
企业名称: {profile.get('company_name', '未设置')}
{profile_ctx}

━━ 近3天相关政策({len(relevant)}条) ━━{loose_hint}
{policy_text}

━━ 政策趋势信号 ━━
{keyword_trend_text or '暂无趋势数据'}

━━ 跨域关联信号 ━━
{signal_text or '暂无跨域信号'}

━━ 全球OSINT情报 ━━
{global_signal_text or '暂无全球信号'}

━━ 国际金融市场与新闻 ━━
{global_data_text or '暂无国际数据'}

━━ 宏观与市场环境 ━━
{regime_text or '暂无环境数据'}
{market_context or '暂无实时行情'}

请基于以上多维数据，以JSON格式输出产业分析简报。分析深度要对标券商研究所行业首席——有产业链传导分析、有量化数据支撑、有国际对标参照。"""

    # 7. Call AI (with user-preferred provider order + custom keys)
    provider_order = profile.get('ai_provider_order') or None
    custom_keys = profile.get('ai_custom_keys') or None
    ai_error = ''
    try:
        raw = call_ai(user_prompt, system_prompt=INDUSTRY_SYSTEM_PROMPT, max_tokens=7000, provider_order=provider_order, custom_keys=custom_keys)
        result = _parse_ai_json(raw)
        if result:
            result['industries'] = industries
            result['policy_count'] = len(relevant)
            result['generated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M')
            if loose_match:
                result['loose_match'] = True
            ttl = _industry_ttl(Config.CACHE_TTL_INDUSTRY_BRIEF_TRADING,
                                Config.CACHE_TTL_INDUSTRY_BRIEF_OFF)
            cache_set(cache_key, result, ttl=ttl)
            # Archive to MySQL for history
            try:
                from services.report_archive import archive_report
                archive_report(
                    user_id=user_id, report_type='industry_brief',
                    content=result, summary=(result.get('headline', '') or '')[:100],
                    risk_score=result.get('industry_health_score'),
                    title=(result.get('headline', '') or '')[:256],
                )
            except Exception as e:
                logger.debug(f'Archive industry brief failed (non-blocking): {e}')
            return result
        ai_error = 'AI returned unparseable response'
    except Exception as e:
        ai_error = str(e)
        logger.warning(f'Industry brief AI failed: {e}')

    # 8. Rule-based fallback
    return _build_rule_fallback(industries, relevant, cross_signals, ai_error)


def get_industry_impacts(user_id: str, limit: int = 10) -> list:
    """Lightweight: return relevant policies with impact tags, no AI call."""
    cache_key = f'cn:industry:impacts:{user_id}:{limit}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    profile = get_profile(user_id)
    if not profile or not profile.get('industries'):
        return []

    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')
    all_policies = get_items_by_date_range(start_date, end_date, limit=300)
    relevant = filter_items_for_user(all_policies, profile, min_relevance=0.15)

    result = []
    for p in relevant[:limit]:
        areas = _detect_affected_areas(p.get('title', ''))
        result.append({
            'title': p.get('title', ''),
            'source': p.get('source', '') or p.get('source_name', ''),
            'date': p.get('date', '') or p.get('news_date', ''),
            'category': p.get('category', ''),
            'url': p.get('url', ''),
            'affected_areas': areas,
            'relevance': round(p.get('_relevance_score', 0), 2),
        })

    ttl = _industry_ttl(Config.CACHE_TTL_INDUSTRY_IMPACTS_TRADING,
                        Config.CACHE_TTL_INDUSTRY_IMPACTS_OFF)
    cache_set(cache_key, result, ttl=ttl)
    return result


def analyze_policy_for_industry(policy_item: dict, industries: list, provider_order=None, custom_keys=None) -> dict:
    """Deep-analyze a single policy for specific industries."""
    title = policy_item.get('title', '')
    # Cache by policy title hash + industries
    key_src = f"{title}|{'|'.join(sorted(industries))}"
    cache_key = f"cn:industry:deep:{hashlib.md5(key_src.encode()).hexdigest()}"
    cached = cache_get(cache_key)
    if cached:
        return cached

    market_context = _build_market_context()
    user_prompt = f"""政策标题: {title}
来源: {policy_item.get('source', '')}
日期: {policy_item.get('date', '')}
分类: {policy_item.get('category', '')}

分析目标行业: {', '.join(industries)}

实时市场信号:
{market_context or '暂无实时行情'}

请以JSON格式输出深度分析，包含以下字段:
supply_chain(供应链影响分析), cost(成本影响分析), competition(竞争格局影响), regulation(监管合规变化), recommended_actions(具体商业建议数组,3-5条), international_reference(海外先例对比,可选), chain_position(产业链上中下游差异化影响,可选)"""

    ai_error = ''
    try:
        raw = call_ai(user_prompt, system_prompt=DEEP_ANALYSIS_PROMPT, max_tokens=1500, provider_order=provider_order, custom_keys=custom_keys)
        result = _parse_ai_json(raw)
        if result:
            result['policy_title'] = title
            result['industries'] = industries
            result['analyzed_at'] = datetime.now().strftime('%Y-%m-%d %H:%M')
            ttl = _industry_ttl(Config.CACHE_TTL_INDUSTRY_DEEP_TRADING,
                                Config.CACHE_TTL_INDUSTRY_DEEP_OFF)
            cache_set(cache_key, result, ttl=ttl)
            return result
        ai_error = 'AI returned unparseable response'
    except Exception as e:
        ai_error = str(e)
        logger.warning(f'Deep analysis AI failed: {e}')

    # Fallback — use real keyword detection, mark AI unavailable
    areas = _detect_affected_areas(title)
    area_text = '、'.join(areas) if areas else '综合'
    return {
        'policy_title': title,
        'industries': industries,
        'supply_chain': f'涉及{area_text}领域，待AI恢复后提供详细分析',
        'cost': f'关键词检测到{area_text}相关影响',
        'competition': f'可能影响{area_text}领域竞争格局',
        'regulation': '需关注后续监管细则' if '监管风险' in areas else '暂未检测到直接监管变化',
        'recommended_actions': [
            f'密切跟踪该政策对{area_text}的后续细则',
            f'评估自身在{area_text}领域的风险敞口',
        ],
        'affected_areas': areas,
        'analyzed_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'ai_unavailable': True,
        'error': ai_error,
    }


# ── Internal helpers ─────────────────────────────────────────────────────────

def _parse_ai_json(raw: str) -> dict | None:
    """Parse AI response as JSON, stripping markdown fences if present."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith('```'):
        # Remove ```json ... ``` wrapper
        lines = text.split('\n')
        lines = [l for l in lines if not l.strip().startswith('```')]
        text = '\n'.join(lines)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in the text
        start = text.find('{')
        end = text.rfind('}')
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    logger.warning(f'Failed to parse AI JSON: {text[:200]}')
    return None


def _detect_affected_areas(title: str) -> list:
    """Keyword-based detection of affected business areas."""
    areas = []
    for area, keywords in AFFECTED_AREA_KEYWORDS.items():
        if any(kw in title for kw in keywords):
            areas.append(area)
    return areas or ['综合']


def _build_empty_brief(industries: list, all_policies: list | None = None) -> dict:
    """Return a brief indicating no relevant policies found, with real data context."""
    total = len(all_policies) if all_policies else 0
    latest_title = ''
    if all_policies:
        latest_title = all_policies[0].get('title', '')

    ind_str = '、'.join(industries[:3])
    headline = f'近3天共{total}条政策，未检测到与{ind_str}直接相关' if total else '近期暂无政策数据'
    summary = f'近3天共采集{total}条政策新闻，未检测到与你关注的{ind_str}行业直接相关的重大政策变化。'
    if latest_title:
        summary += f'最新一条: {latest_title[:40]}'

    return {
        'headline': headline,
        'risk_level': 'low',
        'risk_label': '低',
        'industries': industries,
        'key_developments': [],
        'outlook': {
            'summary': summary,
            'timeframe': '1-4周',
            'key_dates': [],
        },
        'risks': [],
        'opportunities': [],
        'policy_count': 0,
        'total_policy_count': total,
        'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
    }


def _build_rule_fallback(industries: list, policies: list,
                         cross_signals: list | None, error_reason: str = '') -> dict:
    """Rule-based fallback when AI is unavailable."""
    devs = []
    for p in policies[:5]:
        title = p.get('title', '')
        areas = _detect_affected_areas(title)
        # Extract meaningful keywords from title instead of hardcoded text
        area_text = '、'.join(areas)
        devs.append({
            'title': title,
            'source': p.get('source', '') or p.get('source_name', ''),
            'date': p.get('date', '') or p.get('news_date', ''),
            'urgency': 'watch',
            'urgency_label': '关注',
            'impact_summary': f'涉及{area_text}领域，基于关键词匹配',
            'recommended_actions': [
                f'跟踪{area_text}领域后续细则',
                '评估对自身业务的具体影响',
            ],
            'affected_areas': areas,
        })

    risk_level = 'moderate' if len(policies) > 10 else 'low'
    return {
        'headline': f'近3天检测到{len(policies)}条相关政策',
        'risk_level': risk_level,
        'risk_label': RISK_LABELS.get(risk_level, '适中'),
        'industries': industries,
        'key_developments': devs,
        'outlook': {
            'summary': f'AI分析暂时不可用({error_reason})，显示关键词匹配结果',
            'timeframe': '1-4周',
            'key_dates': [],
        },
        'risks': [],
        'opportunities': [],
        'policy_count': len(policies),
        'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'ai_unavailable': True,
        'error': error_reason,
    }
