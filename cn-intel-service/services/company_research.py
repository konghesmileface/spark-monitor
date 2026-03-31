"""AI-powered company research — auto-enrich user profile on company name input.

When user sets company_name in their profile, this module:
1. Calls AI to research the company (industry, sectors, competitors, keywords)
2. Merges AI findings into the profile (without overwriting user's explicit choices)
3. Returns enriched profile data
"""

import json
import logging
import hashlib

logger = logging.getLogger('cn-intel.company-research')

_CACHE_KEY_PREFIX = 'cn:company-research:'
_CACHE_TTL = 86400 * 7  # 7 days


def research_company(company_name: str, user_industries: list = None) -> dict | None:
    """Research a company using AI. Returns enriched profile data or None on failure.

    Returns:
        {
            "company_summary": "一句话公司简介",
            "industries": ["主要行业1", "主要行业2"],
            "tracked_sectors": ["相关板块1", "板块2", ...],
            "tracked_stocks": ["竞对股票代码1", ...],
            "tracked_keywords": ["关键词1", "关键词2", ...],
            "competitors": ["竞对公司1", "竞对公司2"],
            "business_scope": "主营业务描述"
        }
    """
    if not company_name or len(company_name) < 2:
        return None

    # Check Redis cache
    cache_key = _CACHE_KEY_PREFIX + hashlib.md5(company_name.encode()).hexdigest()[:12]
    cached = _get_cached(cache_key)
    if cached:
        logger.warning(f'[company-research] Cache hit for {company_name}')
        return cached

    # AI research prompt
    user_ind_str = '、'.join(user_industries) if user_industries else '未指定'

    prompt = f"""请调研以下中国企业，返回JSON格式的企业画像：

企业名称: {company_name}
用户选择的行业: {user_ind_str}

请返回JSON(只输出JSON，不要其他文字):
{{
    "company_summary": "一句话公司简介(30字内)",
    "industries": ["该公司所属的主要行业(从以下选择: 新能源/半导体/AI/生物医药/新材料/高端装备/汽车制造/消费电子/金融科技/互联网/军工国防/通信/基建/机器人/环保/化工)", "第二行业"],
    "tracked_sectors": ["与该公司业务相关的A股板块概念(5-8个)", "如: 光伏/锂电池/创新药/白酒/半导体设备"],
    "tracked_stocks": ["与该公司有竞争或业务关联的A股上市公司代码(3-5个)", "如: 600519/002594/300750"],
    "tracked_keywords": ["该公司应关注的政策/市场关键词(8-12个)", "如: 集采/医保/带量采购/创新药审批/消费补贴/降息"],
    "competitors": ["主要竞争对手公司名(3-5个)"],
    "business_scope": "主营业务描述(50字内)"
}}

要求:
- industries必须从给定列表中选择，最多3个
- tracked_sectors要具体到A股板块概念名称
- tracked_stocks给6位A股代码(如600519)，要是真实存在的上市公司
- tracked_keywords重点关注会影响该企业的政策方向、行业趋势
- 如果用户已选了行业，以用户选择为主，AI补充"""

    try:
        from services.ai_analysis import call_ai
        result = call_ai(prompt,
                         system_prompt='你是中国企业和A股市场研究专家，精通各行业上市公司。',
                         max_tokens=800)
        if not result:
            return None

        # Parse JSON
        text = result.strip()
        if '```' in text:
            start = text.find('{')
            end = text.rfind('}')
            if start >= 0 and end > start:
                text = text[start:end + 1]

        data = json.loads(text)

        # Validate and clean
        from services.user_profile import AVAILABLE_INDUSTRIES
        valid_industries = set(AVAILABLE_INDUSTRIES)

        enriched = {
            'company_summary': str(data.get('company_summary', ''))[:100],
            'industries': [i for i in data.get('industries', []) if i in valid_industries][:3],
            'tracked_sectors': [str(s) for s in data.get('tracked_sectors', [])][:8],
            'tracked_stocks': [str(s) for s in data.get('tracked_stocks', []) if _is_valid_stock_code(s)][:5],
            'tracked_keywords': [str(k) for k in data.get('tracked_keywords', [])][:12],
            'competitors': [str(c) for c in data.get('competitors', [])][:5],
            'business_scope': str(data.get('business_scope', ''))[:200],
        }

        # Cache result
        _set_cached(cache_key, enriched)

        logger.warning(f'[company-research] Researched {company_name}: '
                       f'{len(enriched["industries"])} industries, '
                       f'{len(enriched["tracked_sectors"])} sectors, '
                       f'{len(enriched["tracked_keywords"])} keywords')
        return enriched

    except json.JSONDecodeError as e:
        logger.warning(f'[company-research] JSON parse error: {e}')
        return None
    except Exception as e:
        logger.warning(f'[company-research] AI research failed: {e}')
        return None


def enrich_profile_with_research(profile_data: dict, research: dict) -> dict:
    """Merge AI research into profile data. User's explicit choices take priority."""
    if not research:
        return profile_data

    merged = dict(profile_data)

    # Industries: keep user's choices, add AI suggestions
    user_industries = set(merged.get('industries', []))
    ai_industries = research.get('industries', [])
    for ind in ai_industries:
        user_industries.add(ind)
    merged['industries'] = list(user_industries)[:3]

    # Sectors: merge (AI fills in what user didn't specify)
    user_sectors = set(merged.get('tracked_sectors', []))
    for s in research.get('tracked_sectors', []):
        user_sectors.add(s)
    merged['tracked_sectors'] = list(user_sectors)[:10]

    # Stocks: merge
    user_stocks = set(merged.get('tracked_stocks', []))
    for s in research.get('tracked_stocks', []):
        user_stocks.add(s)
    merged['tracked_stocks'] = list(user_stocks)[:8]

    # Keywords: merge
    user_kw = set(merged.get('tracked_keywords', []))
    for k in research.get('tracked_keywords', []):
        user_kw.add(k)
    merged['tracked_keywords'] = list(user_kw)[:15]

    return merged


def _is_valid_stock_code(code: str) -> bool:
    """Basic validation for A-share stock codes (6 digits)."""
    code = str(code).strip()
    return len(code) == 6 and code.isdigit()


def _get_cached(cache_key: str):
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            val = r.get(cache_key)
            if val:
                return json.loads(val)
    except Exception:
        pass
    return None


def _set_cached(cache_key: str, data: dict):
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            r.setex(cache_key, _CACHE_TTL, json.dumps(data, ensure_ascii=False))
    except Exception:
        pass
