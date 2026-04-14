"""Competitor Intelligence Tracker — gathers real-time competitor data from
multiple sources (Gemini Search Grounding, DB news, A-share spot quotes),
then calls AI to produce impact/opportunity/risk analysis.

Returns structured dict for the API + formatted_text for AI prompt injection.
"""

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import requests

from config import Config
from services.cache import cache_get, cache_set, is_trading_time

logger = logging.getLogger('cn-intel.competitor')

_URL_RE = None  # lazy compile


def _strip_urls(text: str) -> str:
    """Remove any http/https URLs from text."""
    global _URL_RE
    if _URL_RE is None:
        import re
        _URL_RE = re.compile(r'https?://\S+')
    return _URL_RE.sub('', text).strip()


def _clean_news_results(results: dict) -> dict:
    """Strip grounding redirect URLs from Gemini search results."""
    cleaned = {}
    for company, news_list in results.items():
        if not isinstance(news_list, list):
            continue
        clean_list = []
        for item in news_list:
            if not isinstance(item, dict):
                continue
            title = _strip_urls(item.get('title', ''))
            source = _strip_urls(item.get('source', ''))
            # Skip entries that are just URLs with no meaningful title
            if not title or len(title) < 4:
                continue
            clean_list.append({
                'title': title,
                'source': source,
                'date': item.get('date', ''),
            })
        if clean_list:
            cleaned[company] = clean_list
    return cleaned


# ── Gemini Search Grounding ──────────────────────────────────────────────────

_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
_GEMINI_PROXIES = {'https': 'http://127.0.0.1:17890', 'http': 'http://127.0.0.1:17890'}


def _fetch_competitor_web_news(competitors: list, industries: list) -> dict:
    """Use Gemini Search Grounding to get recent news for all competitors in one call.

    Returns {company_name: [{"title": ..., "source": ..., "date": ...}, ...]}
    """
    api_key = Config.GEMINI_API_KEY
    if not api_key or not competitors:
        return {}

    comp_list = ', '.join(competitors[:5])
    ind_list = ', '.join(industries[:3]) if industries else ''
    prompt = (
        f"请搜索以下公司最近7天的重要新闻动态，每家公司列出最多3条最新新闻。\n"
        f"公司列表: {comp_list}\n"
        f"相关行业: {ind_list}\n\n"
        f"以JSON格式返回，不要markdown代码块:\n"
        f'{{"results": {{"公司名": [{{"title": "标题", "source": "来源", "date": "MM-DD"}}]}}}}'
    )

    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'tools': [{'google_search': {}}],
        'generationConfig': {'maxOutputTokens': 4096, 'temperature': 0.1},
    }

    try:
        resp = requests.post(
            f'{_GEMINI_URL}?key={api_key}',
            json=payload,
            proxies=_GEMINI_PROXIES,
            timeout=30,
        )
        if resp.status_code != 200:
            logger.warning(f'Gemini competitor search failed: HTTP {resp.status_code}')
            return {}

        data = resp.json()
        text = ''
        for candidate in data.get('candidates', []):
            for part in candidate.get('content', {}).get('parts', []):
                text += part.get('text', '')

        # Parse JSON from response
        text = text.strip()
        if text.startswith('```'):
            text = text.split('\n', 1)[-1].rsplit('```', 1)[0]

        parsed = json.loads(text)
        results = parsed.get('results', parsed)
        return _clean_news_results(results)
    except json.JSONDecodeError:
        logger.warning(f'Gemini competitor response not valid JSON: {text[:300]}')
        import re
        m = re.search(r'\{[\s\S]*\}', text)
        if m:
            try:
                parsed = json.loads(m.group())
                return _clean_news_results(parsed.get('results', parsed))
            except json.JSONDecodeError:
                pass
        return {}
    except Exception as e:
        logger.warning(f'Gemini competitor search error: {e}')
        return {}


# ── DB News Query ────────────────────────────────────────────────────────────

def _fetch_db_news(competitors: list, days: int = 7) -> dict:
    """Query local news DB for competitor mentions.

    Returns {company_name: [{"title": ..., "source": ..., "date": ...}, ...]}
    """
    try:
        from services.db_pool import get_connection
    except ImportError:
        return {}

    if not Config.MYSQL_HOST or not competitors:
        return {}

    result = {}
    cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

    try:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                for comp in competitors[:5]:
                    cur.execute(
                        "SELECT info_title, media, news_date FROM news "
                        "WHERE info_title LIKE %s AND news_date >= %s "
                        "ORDER BY news_date DESC LIMIT 3",
                        (f'%{comp}%', cutoff),
                    )
                    rows = cur.fetchall()
                    if rows:
                        result[comp] = [
                            {'title': r[0], 'source': r[1] or '', 'date': str(r[2])[-5:] if r[2] else ''}
                            for r in rows
                        ]
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f'DB competitor news query failed: {e}')

    return result


# ── A-Share Spot Data ────────────────────────────────────────────────────────

def _match_stock_data(competitors: list) -> dict:
    """Match competitor names against A-share spot data for listed companies.

    Returns {company_name: {"stock_code": ..., "stock_price": ..., "stock_change_pct": ...}}
    """
    try:
        from services.data_provider import get_a_spot
    except ImportError:
        return {}

    spot_data = get_a_spot()
    if not spot_data:
        return {}

    result = {}
    for comp in competitors[:5]:
        for item in spot_data:
            name = item.get('name', '')
            # Match by company name (strip common suffixes for fuzzy match)
            comp_short = comp.replace('集团', '').replace('股份', '').replace('有限公司', '')
            if comp_short and (comp_short in name or name in comp):
                code = item.get('code', '')
                market = 'SZ' if code.startswith(('0', '3')) else 'SH'
                result[comp] = {
                    'stock_code': f'{market}:{code}',
                    'stock_price': item.get('price', item.get('close', 0)),
                    'stock_change_pct': item.get('changePercent', item.get('pct_chg', 0)),
                }
                break

    return result


# ── AI Analysis ──────────────────────────────────────────────────────────────

def _generate_analysis(comp_items: list, company_name: str, industries: list,
                       supply_up: list = None, supply_down: list = None) -> dict:
    """Call AI to analyze competitor dynamics and produce actionable insights.

    Returns {"pressure_score": 72, "summary": "...", "action_items": [...],
             "supply_chain_risks": [...],
             "competitors": [{"name": ..., "threat_level": ..., "urgency": ...,
              "impact": "...", "opportunities": [...], "risks": [...]}]}
    """
    try:
        from services.ai_analysis import call_ai
    except ImportError:
        logger.warning('ai_analysis not available for competitor analysis')
        return {}

    # Build context for AI
    lines = []
    for c in comp_items:
        all_news = c.get('web_news', []) + c.get('db_news', [])
        if not all_news:
            continue
        header = f"■ {c['name']}"
        if c.get('is_listed') and c.get('stock_code'):
            header += f" [{c['stock_code']} ¥{c.get('stock_price', 0):.2f} {c.get('stock_change_pct', 0):+.2f}%]"
        lines.append(header)
        for n in all_news[:4]:
            lines.append(f"  - {n.get('title', '')} ({n.get('source', '')}, {n.get('date', '')})")

    if not lines:
        return {}

    news_text = '\n'.join(lines)
    ind_text = '、'.join(industries[:5]) if industries else '未指定'
    up_text = '、'.join(supply_up[:5]) if supply_up else '未填写'
    down_text = '、'.join(supply_down[:5]) if supply_down else '未填写'

    prompt = f"""你是竞争情报分析师。请基于以下竞争对手近期动态，为"{company_name}"提供可行动的竞争分析。

## 我方公司
- 公司: {company_name}
- 行业: {ind_text}
- 上游供应链: {up_text}
- 下游客户: {down_text}

## 竞争对手近期动态
{news_text}

## 要求
请以JSON格式返回（不要markdown代码块）:
{{
  "pressure_score": 0-100整数（当前竞争压力评分，越高压力越大），
  "pressure_trend": "rising/stable/easing",
  "summary": "一段话总结整体竞争态势和最需关注的点（80字以内）",
  "action_items": [
    {{"action": "老板应该做的具体行动（40字以内）", "urgency": "immediate/this_week/watch"}}
  ],
  "supply_chain_risks": ["竞对动态对我方供应链（上游或下游）的潜在影响（每条35字以内，没有就空数组）"],
  "competitors": [
    {{
      "name": "竞对名",
      "threat_level": "high/medium/low",
      "urgency": "immediate/watch/none",
      "impact": "该竞对近期动态对我方的影响（50字以内）",
      "opportunities": ["我方可利用的机遇（每条30字以内）"],
      "risks": ["给我方带来的风险（每条30字以内）"]
    }}
  ]
}}

规则:
- pressure_score: 30以下=低压, 30-60=正常, 60-80=偏高, 80+=高压
- action_items: 最多3条，是老板今天就能做的决策，不是废话（如"建议关注"这种没用）
- urgency: immediate=必须马上应对, this_week=本周内需处理, watch=持续观察
- supply_chain_risks: 结合我方上下游分析，竞对动态是否影响供应商关系或客户流失
- 每个竞对opportunities和risks各1-2条，宁精勿滥
- 必须结合新闻内容给出具体分析，不要空话套话
- 只分析有新闻的竞对"""

    try:
        raw = call_ai(prompt, system_prompt='你是专业的竞争情报分析师，擅长从新闻动态中为企业主提炼可行动的商业洞察。回答务实具体，不要说废话。', max_tokens=2500)
        if not raw:
            return {}

        raw = raw.strip()
        if raw.startswith('```'):
            raw = raw.split('\n', 1)[-1].rsplit('```', 1)[0]

        return json.loads(raw)
    except json.JSONDecodeError:
        import re
        m = re.search(r'\{[\s\S]*\}', raw)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
        logger.warning(f'Competitor analysis JSON parse failed: {raw[:200]}')
        return {}
    except Exception as e:
        logger.warning(f'Competitor AI analysis error: {e}')
        return {}


# ── Main Entry Point ─────────────────────────────────────────────────────────

def gather_competitor_intel(competitors: list, company_name: str = '', industries: list = None,
                           supply_chain_up: list = None, supply_chain_down: list = None) -> dict:
    """Gather competitor intelligence from multiple sources in parallel.

    Args:
        competitors: list of competitor company names (max 5 used)
        company_name: the user's own company name (for context)
        industries: list of industry keywords
        supply_chain_up: upstream suppliers
        supply_chain_down: downstream customers
    """
    if not competitors:
        return {'competitors': [], 'formatted_text': '', 'generated_at': datetime.now().isoformat()}

    industries = industries or []
    comps = competitors[:5]

    # Parallel data gathering
    web_news = {}
    db_news = {}
    stock_data = {}

    with ThreadPoolExecutor(max_workers=3, thread_name_prefix='comp') as pool:
        f_web = pool.submit(_fetch_competitor_web_news, comps, industries)
        f_db = pool.submit(_fetch_db_news, comps)
        f_stock = pool.submit(_match_stock_data, comps)

        try:
            web_news = f_web.result(timeout=35) or {}
        except Exception as e:
            logger.warning(f'Competitor web news failed: {e}')

        try:
            db_news = f_db.result(timeout=10) or {}
        except Exception as e:
            logger.warning(f'Competitor DB news failed: {e}')

        try:
            stock_data = f_stock.result(timeout=10) or {}
        except Exception as e:
            logger.warning(f'Competitor stock data failed: {e}')

    # Build structured result
    comp_items = []
    for name in comps:
        item = {'name': name, 'is_listed': name in stock_data}
        if name in stock_data:
            item.update(stock_data[name])
        item['web_news'] = web_news.get(name, [])
        item['db_news'] = db_news.get(name, [])
        comp_items.append(item)

    # Build formatted text for AI prompt
    lines = ['']
    for c in comp_items:
        header = f"  {c['name']}"
        if c['is_listed']:
            code = c.get('stock_code', '')
            price = c.get('stock_price', 0)
            pct = c.get('stock_change_pct', 0)
            header += f" [{code} \u00a5{price:.2f} {pct:+.2f}%]"
        else:
            header += " [非上市]"
        lines.append(header)

        all_news = c.get('web_news', []) + c.get('db_news', [])
        if all_news:
            for n in all_news[:4]:
                src = n.get('source', '')
                date = n.get('date', '')
                lines.append(f"    - {n.get('title', '')} ({src}, {date})")
        else:
            lines.append("    (暂无近期新闻)")

    formatted = '\n'.join(lines) if len(lines) > 1 else ''

    # AI analysis — only if we have some news
    has_news = any(c.get('web_news') or c.get('db_news') for c in comp_items)
    analysis = {}
    if has_news and company_name:
        try:
            analysis = _generate_analysis(comp_items, company_name, industries,
                                          supply_chain_up, supply_chain_down)
        except Exception as e:
            logger.warning(f'Competitor analysis generation failed: {e}')

    result = {
        'competitors': comp_items,
        'analysis': analysis,
        'formatted_text': formatted,
        'generated_at': datetime.now().isoformat(),
    }

    logger.warning(
        f'[competitor] Gathered intel for {len(comp_items)} competitors: '
        f'web={sum(1 for c in comp_items if c["web_news"])}, '
        f'db={sum(1 for c in comp_items if c["db_news"])}, '
        f'listed={sum(1 for c in comp_items if c["is_listed"])}, '
        f'analysis={"yes" if analysis else "no"}'
    )

    return result
