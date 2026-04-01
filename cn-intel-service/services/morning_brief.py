"""Morning Brief — AI-powered daily intelligence briefing for enterprise users.

Aggregates profile + policies + alerts + industry + cross-domain signals + market
data into a structured, actionable executive brief.
"""

import json
import logging
from datetime import datetime, timedelta

from config import Config
from services.ai_analysis import call_ai
from services.cache import cache_get, cache_set, is_trading_time
from services.global_signals import build_global_signal_context
from services.global_data_feeds import build_global_data_context

logger = logging.getLogger('cn-intel.morning-brief')

# ── AI System Prompt ─────────────────────────────────────────────────────────

BRIEF_SYSTEM_PROMPT = """你是一位服务于中国企业CEO的首席情报分析师。CEO每天早上看这份简报做决策，他需要的不是宏大叙事，而是：
1. 今天市场/行业发生了什么具体的事？（用事实和数据说话）
2. 这些事对我的公司有什么具体影响？（量化到营收/成本/市场份额）
3. 我现在应该马上做什么？（精确到对接谁、签什么合同、调整什么策略）

⚠️ 严禁输出以下类型的废话：
- "建议密切关注""持续跟踪""保持警惕" ← 这些不是行动，是废话
- "市场波动加剧""结构性机会显现""不确定性增加" ← 这些是空洞的套话
- "可能产生影响""或将带来机遇" ← CEO要的是确定性判断，不是模棱两可
- 任何不包含具体公司名、具体数字、具体日期的"分析" ← 那不是分析，是水文

✅ 正确的输出示例：
- ❌ "地缘冲突推高能源价格，市场波动加剧" → ✅ "布伦特原油突破$95/桶(周涨8%)，贵司物流成本月增约120万元"
- ❌ "AI+金融数据需求激增" → ✅ "央行3/21发布《金融数据治理办法》，金融数据服务商必须持牌，贵司已有资质的3个竞对中仅同花顺完成备案"
- ❌ "建议关注政策动向" → ✅ "本周五前联系上海数据交易所申请数据产品挂牌(联系人:张XX)，窗口期仅剩2周"

━━ 输出JSON格式（必须返回合法JSON，不要markdown代码块）━━
{
  "ceo_key_angles": [
    {"angle": "市场/行业", "insight": "标题(≤30字)：今天行业最大的变化", "detail": "2-3句话展开：①具体事件+数据源 ②行业趋势如何变化 ③哪些玩家受影响最大", "metric": "核心数字(如'PMI 50.5↑0.3'或'油价$100/桶↑15%')"},
    {"angle": "公司影响", "insight": "标题(≤30字)：对我司的核心冲击", "detail": "2-3句话展开：①营收/成本/利润的量化影响 ②竞争格局如何变化 ③客户/供应商端的连锁反应", "metric": "关键影响数字(如'成本月增80万'或'毛利率-1.5pp')"},
    {"angle": "马上行动", "insight": "标题(≤30字)：CEO今天第一件事", "detail": "2-3句话展开：①为什么是现在(窗口期/紧迫性) ②具体步骤和对接人 ③预期结果/止损效果", "metric": "截止时间(如'本周五前'或'今日内')"}
  ],
  "headline_alert": "今日最重要的一件事(≤40字)：引用具体政策名/公司名/数字，说明对贵司的直接影响",
  "key_number": "最关键的一个数字(如'原材料涨价将侵蚀毛利率2.3pp'、'竞对A轮融5亿正式进入我们赛道')",
  "situation_delta": "跟上周/昨天相比，最大的变化是什么(2-3句)——必须是边际变化而非存量描述，引用具体事件和数据",
  "executive_summary": {
    "situation": "当前形势(2-3句)：引用具体的宏观数据(PMI值/CPI值/LPR值)+具体政策文件名+行业数据，不要泛泛而谈",
    "impact": "对贵司的影响(2-3句)：必须涉及具体的营收金额/成本变化/市场份额变动/现金流影响，用数字说话",
    "direction": "CEO应该做什么(2-3句)：给出3个以内的具体动作，每个动作要说清楚"做什么+找谁做+什么时候做完""
  },
  "risk_score": "0-100整数",
  "risk_trend": "rising|stable|falling",
  "risk_velocity_summary": "最近一周风险变化速度总结(1句话，标明哪些风险在加速恶化)",
  "opportunity_windows": [{"opp": "机会名", "closes_at": "窗口关闭时间(具体日期)", "action_needed": "需要立即做什么(≤30字)"}],
  "macro_snapshot": {
    "economy_phase": "复苏|过热|滞胀|衰退|底部企稳",
    "policy_stance": "宽松|中性偏松|中性|中性偏紧|收紧",
    "key_indicators": "2-3个最关键宏观指标+最新值+环比变化(如'3月PMI 50.5↑0.3/CPI 0.7%↓0.1pp/社融+12.5%')",
    "fiscal_highlight": "最新财政政策(引用文件名和日期)",
    "monetary_highlight": "最新货币政策操作(引用具体金额和利率)"
  },
  "opportunities": [
    {
      "title": "机遇标题≤15字(必须包含具体事件或政策名)",
      "description": "80-150字分析：①触发事件是什么(引用政策号/公司名/日期) ②通过什么路径影响贵司(A→B→C) ③量化影响多大(营收+X%或成本-Y万) ④为什么现在是窗口期",
      "source": "宏观|财政|货币|产业|区域|国际|竞争|技术",
      "impact_score": "1-10整数",
      "impact_dimension": "营收增长|利润改善|市场份额|供应链|合规|竞争格局|技术壁垒|融资环境",
      "estimated_effect": "量化预估(必填，如'+2.5亿元/年'或'毛利率+1.5pp'或'市占率+3%')",
      "urgency": "high|medium|low",
      "confidence": "high|medium|low",
      "time_window": "窗口期(如'本周五前'、'Q2政策窗口')",
      "action": "立即行动≤50字：做什么+找谁+什么时候完成",
      "potential_value": "预估对企业的财务影响(如'年营收增加500-800万元'或'成本节省200万/年')",
      "action_deadline": "行动截止时间(如'2026-04-01前'或'本周五前')",
      "transmission_chain": ["具体触发事件(引用政策号/公司名/日期)", "一阶效应(行业层面变化+数据)", "二阶效应(竞争格局变化)", "对贵司的具体影响+量化数字+行动建议"]
    }
  ],
  "risks": [
    {
      "title": "风险标题≤15字(必须包含具体威胁来源)",
      "description": "80-150字分析：①风险源头是什么(具体事件/政策/竞对动作) ②传导路径(A→B→C) ③最坏情况下损失多少 ④目前概率多大(引用历史对标)",
      "source": "宏观|财政|货币|产业|区域|国际|竞争|监管",
      "impact_score": "1-10整数",
      "impact_dimension": "营收增长|利润改善|市场份额|供应链|合规|竞争格局|技术壁垒|融资环境",
      "estimated_loss": "量化预估损失(必填，如'-1.8亿元'或'毛利率-2pp')",
      "probability": "high|medium|low",
      "urgency": "high|medium|low",
      "velocity": "fast|medium|slow",
      "risk_velocity": "fast|accelerating|stable|decelerating",
      "early_warning": "预警阈值(如'若布伦特油价破$100/桶，需立即启动B计划')",
      "second_order_effect": "二阶效应(如'→竞对X趁机降价→我们丢失客户Y')",
      "mitigation": "对冲措施≤50字：做什么+找谁+什么时候完成",
      "transmission_chain": ["具体触发事件(引用信息源)", "一阶效应(直接冲击+数据)", "二阶效应(竞争格局变化)", "对贵司的具体损失+量化数字+对冲建议"]
    }
  ],
  "action_items": [
    {
      "action": "今天/本周要做的具体事(≤50字)：精确到找谁、做什么、什么结果",
      "priority": "urgent|important|monitor",
      "deadline_hint": "今天|本周内|本月|本季度",
      "related_risk_or_opp": "对应的风险或机遇标题",
      "owner": "负责部门(战略部/财务部/法务合规/采购部/销售部/技术部)"
    }
  ],
  "competitive_landscape": {
    "summary": "竞争格局变化(2-3句)：最近一周竞对做了什么+行业集中度在怎么变+我们排第几",
    "market_concentration": "CR3/CR5变化趋势(引用数据)",
    "competitors": [{"name":"竞对公司全称", "impact":"最近的动作及影响≤35字", "your_advantage":"我们相对这个竞对的具体优势≤30字", "threat_level":"high|medium|low"}],
    "recent_moves": ["竞对近期动作(公司名+做了什么+影响)，每条≤30字"],
    "new_entrants": "新进入者(公司名+背景+威胁程度)，无新进入者则输出空字符串\"\"",
    "substitutes": "替代品威胁(产品名+替代路径)，无替代品则输出空字符串\"\""
  },
  "industry_direction": {
    "trend": "improving|stable|deteriorating",
    "trend_label": "向好|平稳|承压",
    "summary": "产业走势(2句)：引用最新行业数据(产量/开工率/价格指数/订单量)",
    "key_indicator": "最关键先行指标+最新值+变化方向",
    "capacity_cycle": "产能周期位置(引用开工率/在建产能/投产计划等数据)",
    "tech_roadmap": "技术路线最新进展(引用具体公司/产品/技术节点)",
    "demand_outlook": "下游需求最新信号(引用订单/出货量/终端销售数据)",
    "regulatory_trend": "最新监管动态(引用具体政策文件名和日期)"
  },
  "global_impact": {
    "summary": "国际环境对贵司的一句话总结(引用具体事件)",
    "trade_relations": "贸易关系最新动态及对贵司进出口/供应链的影响(引用具体关税/禁令/协定)",
    "forex_commodities": "汇率(美元/人民币最新值)+核心原材料价格变动及对贵司成本影响",
    "geopolitical": "地缘风险及对供应链的具体影响(无则输出空字符串\"\")",
    "supply_chain_shifts": "全球供应链重构对贵司布局的影响(无则输出空字符串\"\")",
    "prediction_markets": "预测市场信号(基于Polymarket数据，无数据则输出空字符串\"\")"
  },
  "executive_perspectives": [
    {
      "role": "CEO",
      "role_label": "首席执行官",
      "focus": "整体战略与资源配置",
      "near_term": "0-3个月：需要立即做出的决策和行动(≤80字，含具体数字和对接人)",
      "mid_term": "3-12个月：需要启动的战略部署(≤80字，含里程碑节点)",
      "long_term": "1-3年：需要提前布局的方向(≤60字，含趋势判断)"
    },
    {
      "role": "CMO",
      "role_label": "市场总监",
      "focus": "市场份额与客户策略",
      "near_term": "0-3个月：客户/渠道/品牌需要立即调整的事项(≤80字，含具体市场数据)",
      "mid_term": "3-12个月：市场布局和客户结构优化(≤80字，含目标值)",
      "long_term": "1-3年：市场格局演变与品牌定位(≤60字)"
    },
    {
      "role": "CFO",
      "role_label": "财务总监",
      "focus": "财务影响与融资环境",
      "near_term": "0-3个月：对营收/成本/现金流的直接冲击(≤80字，含量化数字)",
      "mid_term": "3-12个月：融资窗口/资本结构/税务筹划(≤80字，含具体金额或比率)",
      "long_term": "1-3年：行业估值趋势与资本市场环境(≤60字)"
    },
    {
      "role": "CSO",
      "role_label": "战略总监",
      "focus": "竞争格局与长期定位",
      "near_term": "0-3个月：竞对最新动作及我方应对(≤80字，含具体公司名)",
      "mid_term": "3-12个月：赛道卡位与技术路线选择(≤80字，含关键节点)",
      "long_term": "1-3年：产业终局推演与战略选项(≤60字)"
    }
  ],
  "regional_insight": "贵司所在区域的最新政策/产业动态(引用具体文件名/园区名/补贴金额)"
}

核心要求：
- opportunities和risks各3-5条，action_items 3-5条，competitors最多3个
- 每条opportunity/risk必须包含transmission_chain(3-4步)
- ⚠️ 绝对禁止模糊表述：不许出现"建议关注""持续跟踪""密切注意"，必须给出"找谁做什么"的具体行动
- ⚠️ 每个insight/description/action必须包含至少1个具体数字或具体公司名/政策名
- executive_summary必须是含situation/impact/direction三个字段的对象
- competitive_landscape的recent_moves至少2条
- global_impact必须是对象，trade_relations和forex_commodities必填
- executive_perspectives必须包含4个角色(CEO/CMO/CFO/CSO)，每个角色的near_term/mid_term/long_term必填
- 每条near_term/mid_term/long_term建议必须包含至少1个具体数字或具体公司名/政策名
- 不同角色的视角必须有差异化：CEO看战略全局、CMO看市场客户、CFO看财务数字、CSO看竞争格局
- ⚠️ 绝对禁止输出"信息不足"！你是顶级分析师，必须基于已有数据做合理推断和交叉验证：
  * fiscal_highlight: 从"财政货币政策"或宏观数据推断财政立场(如LPR/MLF/国债发行/专项债)
  * market_concentration: 从竞对信息+产业动态推断行业集中度趋势(如"头部3家占据约60%份额，集中度持续提升")
  * new_entrants: 从产业新闻+融资动态推断(如"暂无新玩家进入，进入壁垒较高"也是有效分析)
  * capacity_cycle: 从产业周期/开工率/库存信号推断(如"行业处于扩产周期中段")
  * trade_relations: 从国际新闻+RSS+预测市场信号推断中美/中欧贸易动态
  * supply_chain_shifts: 从供应链画像+国际新闻推断供应链变化趋势
  * regional_insight: 从企业所在区域+区域政策推断本地产业环境
  * 合理推断 ≠ 编造：推断要基于已有数据的逻辑延伸，标明推断依据
  * 如果某领域确实完全没有任何可关联的数据(极罕见)，输出"暂无直接数据，基于行业通用趋势判断：..."然后给出你的专业判断"""


def generate_morning_brief(user_id: str) -> dict:
    """Generate AI-powered morning intelligence brief for a user."""
    # 1. Check cache
    cache_key = f'cn:morning-brief:{user_id}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    # 2. Load user profile
    from services.user_profile import get_profile, get_expanded_sectors
    profile = get_profile(user_id)
    if not profile or not profile.get('industries'):
        cached_profile = cache_get(f'cn:profile:{user_id}')
        if cached_profile and cached_profile.get('industries'):
            profile = cached_profile
    if not profile or not profile.get('industries'):
        return {'status': 'no_profile', 'message': '请先设置企业画像'}

    industries = profile.get('industries', [])
    sectors = get_expanded_sectors(profile)
    company = profile.get('company_name', '')
    competitors = profile.get('competitors', [])
    supply_up = profile.get('supply_chain_up', [])
    supply_down = profile.get('supply_chain_down', [])
    compliance = profile.get('compliance_concerns', [])
    regions = profile.get('business_regions', [])
    business_scope = profile.get('business_scope', '')

    # 3. Gather data sources
    from services.policy_store import get_items_by_date_range
    from services.relevance_scorer import filter_items_for_user
    from services.alert_engine import get_alert_stats, get_user_alerts
    from services.industry_advisor import generate_industry_brief
    from services.cross_domain_engine import build_correlation_context, detect_cross_signals, detect_regime
    from services.delta_tracker import compute_delta
    from services.data_provider import get_north_flow, get_sector_rank, get_macro_indicators, get_margin_data, get_sector_rotation

    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d')
    all_policies = get_items_by_date_range(start_date, end_date, limit=500)
    relevant = filter_items_for_user(all_policies, profile, min_relevance=0.15)

    # Alerts
    alert_stats = get_alert_stats(user_id, days=3)
    flash_alerts = get_user_alerts(user_id, tier='FLASH', limit=5)
    priority_alerts = get_user_alerts(user_id, tier='PRIORITY', limit=5)

    # Industry brief (may be cached already)
    industry_brief = generate_industry_brief(user_id)

    # Cross-domain signals
    context = build_correlation_context(sectors)
    cross_signals = detect_cross_signals(context)[:5]
    regime = detect_regime()

    # Delta tracker
    delta = compute_delta(user_id)

    # Market data
    market_parts = []
    try:
        sector_rank = get_sector_rank(top_n=5)
        if sector_rank:
            lines = [f"  {s['name']}: {s['changePercent']:+.2f}%" for s in sector_rank[:5]]
            market_parts.append('板块涨跌TOP5:\n' + '\n'.join(lines))
    except Exception as e:
        logger.debug(f'Brief: sector_rank fetch error: {e}')
    try:
        north = get_north_flow()
        if north and north.get('totalFlow', 0) != 0:
            total = north['totalFlow']
            d = '净流入' if total > 0 else '净流出'
            market_parts.append(f'北向资金: {d} {abs(total):.0f}万元')
    except Exception as e:
        logger.debug(f'Brief: north_flow fetch error: {e}')

    # Macro economic indicators
    macro_text = ''
    try:
        macro = get_macro_indicators()
        if macro:
            parts = []
            if macro.get('cpi'):
                parts.append(f"CPI: {macro['cpi']}")
            if macro.get('ppi'):
                parts.append(f"PPI: {macro['ppi']}")
            if macro.get('pmi'):
                parts.append(f"PMI: {macro['pmi']}")
            if parts:
                macro_text = '宏观指标: ' + ' | '.join(parts)
    except Exception as e:
        logger.debug(f'Brief: macro_indicators fetch error: {e}')

    # Margin trading data
    margin_text = ''
    try:
        margin = get_margin_data()
        if margin and margin.get('balance'):
            margin_text = f"融资融券余额: {margin['balance']:.0f}亿元"
            if margin.get('change'):
                margin_text += f" (日变化: {margin['change']:+.0f}亿元)"
    except Exception as e:
        logger.debug(f'Brief: margin_data fetch error: {e}')

    # Sentiment / social mood
    sentiment_text = ''
    try:
        mood_data = cache_get('cn:mood:social') or {}
        if mood_data.get('distribution'):
            d = mood_data['distribution']
            sentiment_text = f"舆情情绪: 正面{d.get('positive',0)} 负面{d.get('negative',0)} 中性{d.get('neutral',0)}"
            kws = mood_data.get('keywords', [])
            if kws:
                sentiment_text += f"\n舆情热词: {', '.join(k.get('word','') for k in kws[:10])}"
    except Exception as e:
        logger.debug(f'Brief: sentiment fetch error: {e}')

    # Sector rotation
    rotation_text = ''
    try:
        rotation = get_sector_rotation(top_n=5)
        if rotation:
            lines = [f"  {r['name']}: 动量{r.get('momentum',0):+.2f}%" for r in rotation[:5]]
            rotation_text = '板块轮动:\n' + '\n'.join(lines)
    except Exception as e:
        logger.debug(f'Brief: sector_rotation fetch error: {e}')

    # Policy keyword trends
    keyword_trend_text = ''
    try:
        from services.policy_signal_tracker import compute_keyword_trends
        kw_trends = compute_keyword_trends(days_back=7)
        if kw_trends:
            rising = [f"{k['keyword']}(+{k['change']}%)" for k in kw_trends if k.get('change', 0) > 0][:5]
            if rising:
                keyword_trend_text = f"政策热词趋势(7日): {', '.join(rising)}"
    except Exception as e:
        logger.debug(f'Brief: keyword_trends fetch error: {e}')

    # 4. Build AI prompt
    policy_text = '\n'.join(
        f"- [{p.get('category','')}] {p['title']} ({p.get('source','')}, {p.get('date','')})"
        for p in relevant[:15]
    )

    # Targeted policy filtering for specific fields
    fiscal_policies = get_items_by_date_range(start_date, end_date, category='财政货币', limit=10)
    fiscal_text = '\n'.join(
        f"- {p['title']} ({p.get('source','')}, {p.get('date','')})"
        for p in fiscal_policies[:8]
    ) if fiscal_policies else ''

    trade_policies = get_items_by_date_range(start_date, end_date, category='外贸外交', limit=10)
    intl_cb_policies = get_items_by_date_range(start_date, end_date, category='国际央行', limit=5)
    trade_text = '\n'.join(
        f"- {p['title']} ({p.get('source','')}, {p.get('date','')})"
        for p in (trade_policies + intl_cb_policies)[:10]
    ) if (trade_policies or intl_cb_policies) else ''

    # Regional policy filtering based on user's business regions
    regional_policies_text = ''
    if regions:
        region_keywords = regions[:5]
        from services.policy_store import search_items
        region_results = []
        for rk in region_keywords:
            results = search_items(rk, limit=5)
            region_results.extend(results)
        if region_results:
            seen_titles = set()
            deduped_regional = []
            for p in region_results:
                if p['title'] not in seen_titles:
                    seen_titles.add(p['title'])
                    deduped_regional.append(p)
            regional_policies_text = '\n'.join(
                f"- [{p.get('category','')}] {p['title']} ({p.get('source','')}, {p.get('date','')})"
                for p in deduped_regional[:8]
            )

    alert_text = ''
    all_alerts = flash_alerts + priority_alerts
    if all_alerts:
        alert_text = '\n'.join(
            f"- [{a.get('tier','?')}] {a.get('title','')} — {a.get('reason','')}"
            for a in all_alerts[:10]
        )

    signal_text = '\n'.join(
        f"- [{s.get('pattern','')}] {s.get('sector','')}: {s.get('description','')}"
        for s in (cross_signals or [])[:5]
    )

    industry_text = ''
    if industry_brief and industry_brief.get('headline'):
        industry_text = f"产业概况: {industry_brief['headline']}"
        if industry_brief.get('outlook', {}).get('summary'):
            industry_text += f"\n展望: {industry_brief['outlook']['summary']}"
        # Inject detailed industry data for capacity_cycle / competitive_dynamics / supply_chain
        cycle = industry_brief.get('industry_cycle', {})
        if cycle:
            parts = []
            if cycle.get('stage'):
                parts.append(f"周期阶段: {cycle['stage']}")
            if cycle.get('capacity_cycle'):
                parts.append(f"产能周期: {cycle['capacity_cycle']}")
            if cycle.get('inventory_cycle'):
                parts.append(f"库存周期: {cycle['inventory_cycle']}")
            if cycle.get('summary'):
                parts.append(cycle['summary'])
            if parts:
                industry_text += f"\n产业周期: {' | '.join(parts)}"
        comp_dyn = industry_brief.get('competitive_dynamics', '')
        if comp_dyn:
            industry_text += f"\n竞争格局: {comp_dyn}"
        scm = industry_brief.get('supply_chain_map', {})
        if scm:
            if scm.get('upstream'):
                industry_text += f"\n上游: {scm['upstream']}"
            if scm.get('midstream'):
                industry_text += f"\n中游: {scm['midstream']}"
            if scm.get('downstream'):
                industry_text += f"\n下游: {scm['downstream']}"
        intl_ctx = industry_brief.get('international_context', '')
        if intl_ctx:
            industry_text += f"\n国际对标: {intl_ctx}"

    delta_text = ''
    if delta and delta.get('summary'):
        delta_text = f"变化追踪: {delta['summary']}"
        if delta.get('emerging_keywords'):
            delta_text += f"\n新兴关键词: {', '.join(delta['emerging_keywords'][:5])}"

    regime_text = ''
    if regime:
        regime_text = f"市场环境: {regime.get('label', '')} — {regime.get('description', '')}"

    comp_text = ''
    if competitors:
        comp_text = f"主要竞争对手: {', '.join(competitors[:5])}"

    supply_text = ''
    if supply_up:
        supply_text += f"\n上游供应链: {', '.join(supply_up[:8])}"
    if supply_down:
        supply_text += f"\n下游客户/渠道: {', '.join(supply_down[:8])}"

    compliance_text = ''
    if compliance:
        compliance_text = f"\n合规关注点: {', '.join(compliance[:8])}"

    region_text = ''
    if regions:
        region_text = f"\n经营区域: {', '.join(regions[:8])}"

    scope_text = ''
    if business_scope:
        scope_text = f"\n主营业务: {business_scope}"

    # Global OSINT signals
    global_signal_text = ''
    try:
        global_signal_text = build_global_signal_context(user_id, max_items=5)
    except Exception as e:
        logger.warning(f'Global signals fetch failed (non-blocking): {e}')

    # International data feeds (RSS + Yahoo Finance + Polymarket)
    global_data_text = ''
    try:
        global_data_text = build_global_data_context(user_id, profile)
    except Exception as e:
        logger.warning(f'Global data feeds fetch failed (non-blocking): {e}')

    user_prompt = f"""━━ 企业画像 ━━
企业名称: {company or '未设置'}{scope_text}
关注行业: {', '.join(industries)}
相关板块: {', '.join(sectors[:10])}
{comp_text}{supply_text}{compliance_text}{region_text}

━━ 宏观经济环境 ━━
{macro_text or '暂无宏观数据'}
{regime_text or '市场环境: 暂无数据'}

━━ 货币与资金面 ━━
{margin_text or '暂无融资融券数据'}

━━ 近3天相关政策({len(relevant)}条) ━━
{policy_text or '暂无相关政策'}

━━ 政策趋势信号 ━━
{keyword_trend_text or '暂无趋势数据'}

━━ 重要告警({len(all_alerts)}条) ━━
{alert_text or '暂无告警'}

━━ 跨域关联信号 ━━
{signal_text or '暂无跨域信号'}

━━ 全球OSINT情报 ━━
{global_signal_text or '暂无全球信号'}

━━ 国际金融市场与新闻 ━━
{global_data_text or '暂无国际数据'}

━━ 财政货币政策(专项) ━━
{fiscal_text or '暂无财政货币政策'}

━━ 外贸外交与国际央行 ━━
{trade_text or '暂无外贸外交政策'}

━━ 区域政策(贵司所在区域) ━━
{regional_policies_text or '暂无区域相关政策'}

━━ 产业动态(详细) ━━
{industry_text or '暂无产业数据'}

━━ 舆情与市场情绪 ━━
{sentiment_text or '暂无舆情数据'}

━━ 变化追踪 ━━
{delta_text or '暂无变化数据'}

━━ 实时市场 ━━
{chr(10).join(market_parts) if market_parts else '暂无实时行情'}
{rotation_text}

请基于以上多维数据，生成今日情报简报JSON。分析要达到券商研究所首席分析师水准——有因果链、有量化锚点、有二阶效应推演。"""

    # 5. Call AI (with user-preferred provider order + custom keys)
    provider_order = profile.get('ai_provider_order') or None
    custom_keys = profile.get('ai_custom_keys') or None
    try:
        raw = call_ai(user_prompt, system_prompt=BRIEF_SYSTEM_PROMPT, max_tokens=8192, provider_order=provider_order, custom_keys=custom_keys)
        result = _parse_ai_json(raw)
        if result:
            result['generated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M')
            result['policy_count'] = len(relevant)
            result['alert_count'] = alert_stats.get('total', 0)
            result['status'] = 'ok'
            ttl = Config.CACHE_TTL_MORNING_BRIEF_TRADING if is_trading_time() else Config.CACHE_TTL_MORNING_BRIEF_OFF
            cache_set(cache_key, result, ttl=ttl)
            # Archive to MySQL for history
            try:
                from services.report_archive import archive_report
                angles = result.get('ceo_key_angles', [])
                summary = (angles[0]['insight'] if angles else '') or result.get('ceo_one_liner') or result.get('headline_alert', '')
                archive_report(
                    user_id=user_id, report_type='morning_brief',
                    content=result, summary=summary[:100],
                    risk_score=result.get('risk_score'),
                    title=result.get('headline_alert', '')[:256],
                )
            except Exception as e:
                logger.debug(f'Archive morning brief failed (non-blocking): {e}')
            return result
    except Exception as e:
        logger.warning(f'Morning brief AI failed: {e}')

    # 6. Rule-based fallback
    return _build_fallback_brief(profile, relevant, all_alerts, industry_brief, delta)


def _build_fallback_brief(profile: dict, policies: list, alerts: list,
                          industry_brief: dict | None, delta: dict | None) -> dict:
    """Rule-based fallback when AI is unavailable."""
    industries = profile.get('industries', [])
    ind_str = '、'.join(industries[:3])

    # Build opportunities from positive alerts/signals
    opportunities = []
    for a in alerts[:3]:
        if a.get('tier') == 'FLASH' or '机遇' in a.get('reason', '') or '利好' in a.get('reason', ''):
            opportunities.append({
                'title': (a.get('title', '') or '')[:15],
                'description': a.get('reason', '基于告警系统检测'),
                'source': '政策',
                'impact_score': 5,
                'impact_dimension': '营收增长',
                'estimated_effect': '待AI评估',
                'urgency': 'medium',
                'action': '跟踪后续政策细则',
            })

    # Build risks from high-priority alerts
    risks = []
    for a in alerts[:3]:
        if '风险' in a.get('reason', '') or '利空' in a.get('reason', ''):
            risks.append({
                'title': (a.get('title', '') or '')[:15],
                'description': a.get('reason', '基于告警系统检测'),
                'source': '政策',
                'impact_score': 5,
                'impact_dimension': '合规',
                'estimated_loss': '待AI评估',
                'probability': 'medium',
                'urgency': 'medium',
                'mitigation': '评估影响范围',
            })

    # Executive summary
    summary_parts = []
    if policies:
        summary_parts.append(f'近3天检测到{len(policies)}条与{ind_str}相关的政策')
    if alerts:
        summary_parts.append(f'{len(alerts)}条重要告警')
    if delta and delta.get('new_policies'):
        summary_parts.append(f'距上次查看新增{delta["new_policies"]}条政策')
    exec_summary = '。'.join(summary_parts) + '。' if summary_parts else f'{ind_str}行业暂无重大政策变化。'

    # Industry direction from brief
    direction = {'trend': 'stable', 'trend_label': '平稳', 'summary': '待AI恢复后生成详细分析', 'key_indicator': ''}
    if industry_brief and industry_brief.get('risk_level'):
        rl = industry_brief['risk_level']
        if rl in ('high', 'critical'):
            direction = {'trend': 'deteriorating', 'trend_label': '承压', 'summary': industry_brief.get('headline', ''), 'key_indicator': ''}
        elif rl == 'low':
            direction = {'trend': 'improving', 'trend_label': '向好', 'summary': industry_brief.get('headline', ''), 'key_indicator': ''}
        else:
            direction['summary'] = industry_brief.get('headline', '')

    return {
        'status': 'ok',
        'headline_alert': f'{ind_str}行业近3天有{len(policies)}条相关政策' if policies else '',
        'key_number': f'{len(policies)}条相关政策' if policies else '',
        'executive_summary': exec_summary,
        'risk_score': 50,
        'risk_trend': 'stable',
        'opportunities': opportunities,
        'risks': risks,
        'action_items': [{'action': f'跟踪{ind_str}领域政策后续细则', 'priority': 'important', 'deadline_hint': '本周内', 'related_risk_or_opp': ''}] if policies else [],
        'competitive_landscape': {'summary': 'AI分析暂时不可用', 'competitors': []},
        'industry_direction': direction,
        'generated_at': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'policy_count': len(policies),
        'alert_count': len(alerts),
        'ai_unavailable': True,
    }


def _parse_ai_json(raw: str) -> dict | None:
    """Parse AI response as JSON, stripping markdown fences if present."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith('```'):
        lines = text.split('\n')
        lines = [l for l in lines if not l.strip().startswith('```')]
        text = '\n'.join(lines)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find('{')
        end = text.rfind('}')
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    logger.warning(f'Failed to parse morning brief JSON: {text[:200]}')
    return None
