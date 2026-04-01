"""Multi-provider AI analysis engine.
Fallback chain: DeepSeek → Gemini → Claude → DashScope."""

import logging
import threading
import requests
from config import Config

logger = logging.getLogger('cn-intel.ai')

# Concurrency control: max 5 simultaneous AI calls
_ai_semaphore = threading.Semaphore(5)

# Provider configurations
_PROVIDERS = [
    {
        'name': 'deepseek',
        'type': 'openai',
        'url': 'https://api.deepseek.com/v1/chat/completions',
        'model': 'deepseek-chat',
        'key_attr': 'DEEPSEEK_API_KEY',
    },
    {
        'name': 'gemini',
        'type': 'gemini',
        'url': 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
        'key_attr': 'GEMINI_API_KEY',
    },
    {
        'name': 'claude',
        'type': 'anthropic',
        'url': 'https://api.anthropic.com/v1/messages',
        'model': 'claude-sonnet-4-5-20250929',
        'key_attr': 'ANTHROPIC_API_KEY',
    },
    {
        'name': 'dashscope',
        'type': 'openai',
        'url': 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        'model': 'qwen-plus',
        'key_attr': 'DASHSCOPE_API_KEY',
    },
]


def call_ai(prompt, system_prompt='你是一个专业的中国A股市场分析师。', max_tokens=2000, provider_order=None, custom_keys=None):
    """Call AI with multi-provider fallback chain and concurrency control.

    Args:
        provider_order: optional list of provider names e.g. ["gemini","deepseek"].
                        Providers not in the list are appended as final fallback.
        custom_keys: optional dict of {provider_name: api_key} for user-supplied keys.
    """
    # DeepSeek enforces max 8192 tokens; clamp to avoid 400 errors
    max_tokens = min(max_tokens, 8192)

    if not _ai_semaphore.acquire(timeout=60):
        logger.warning('AI semaphore timeout (60s), too many concurrent calls')
        return None

    try:
        return _call_ai_inner(prompt, system_prompt, max_tokens, provider_order, custom_keys)
    finally:
        _ai_semaphore.release()


def get_available_providers(custom_keys=None) -> list:
    """Return [{name, label, available}] for all known providers.

    Args:
        custom_keys: optional dict of {provider_name: api_key}. A provider is
                     marked available if either platform key or custom key exists.
    """
    labels = {
        'deepseek': 'DeepSeek',
        'gemini': 'Gemini',
        'claude': 'Claude',
        'dashscope': '通义千问',
    }
    ck = custom_keys or {}
    result = []
    for p in _PROVIDERS:
        platform_key = getattr(Config, p['key_attr'], '')
        user_key = ck.get(p['name'], '')
        result.append({
            'name': p['name'],
            'label': labels.get(p['name'], p['name']),
            'available': bool(platform_key or user_key),
        })
    return result


def _reorder_providers(provider_order):
    """Reorder _PROVIDERS based on user preference. Unknown names are ignored.
    Providers not in user list are appended as fallback."""
    if not provider_order:
        return list(_PROVIDERS)

    by_name = {p['name']: p for p in _PROVIDERS}
    ordered = []
    seen = set()
    for name in provider_order:
        if name in by_name and name not in seen:
            ordered.append(by_name[name])
            seen.add(name)
    # Append remaining as fallback
    for p in _PROVIDERS:
        if p['name'] not in seen:
            ordered.append(p)
    return ordered


def _call_ai_inner(prompt, system_prompt, max_tokens, provider_order=None, custom_keys=None):
    """Internal: actual AI call logic."""
    proxies = {}
    if Config.HTTP_PROXY:
        proxies['http'] = Config.HTTP_PROXY
    if Config.HTTPS_PROXY:
        proxies['https'] = Config.HTTPS_PROXY

    # Scale timeout with max_tokens: base 30s + 10s per 1000 tokens
    timeout = max(30, 30 + (max_tokens // 1000) * 10)

    providers = _reorder_providers(provider_order)
    ck = custom_keys or {}

    for provider in providers:
        api_key = ck.get(provider['name'], '') or getattr(Config, provider['key_attr'], '')
        if not api_key:
            continue

        try:
            if provider['type'] == 'openai':
                result = _call_openai_compatible(provider, api_key, prompt, system_prompt, max_tokens, proxies, timeout)
            elif provider['type'] == 'gemini':
                result = _call_gemini(provider, api_key, prompt, system_prompt, max_tokens, proxies, timeout)
            elif provider['type'] == 'anthropic':
                result = _call_anthropic(provider, api_key, prompt, system_prompt, max_tokens, proxies, timeout)
            else:
                continue

            if result:
                logger.warning(f'AI call succeeded via {provider["name"]}')
                return result
        except Exception as e:
            logger.warning(f'{provider["name"]} call failed: {e}')
            continue

    logger.warning('All AI providers failed')
    return None


def _call_openai_compatible(provider, api_key, prompt, system_prompt, max_tokens, proxies, timeout=30):
    """Call OpenAI-compatible API (DeepSeek, DashScope)."""
    resp = requests.post(
        provider['url'],
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
        },
        json={
            'model': provider['model'],
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': prompt},
            ],
            'max_tokens': max_tokens,
            'temperature': 0.7,
        },
        proxies=proxies or None,
        timeout=timeout,
    )
    if resp.status_code == 200:
        data = resp.json()
        choice = data['choices'][0]
        finish_reason = choice.get('finish_reason', '')
        if finish_reason == 'length':
            logger.warning(f'{provider["name"]} output truncated (finish_reason=length, max_tokens={max_tokens})')
        return choice['message']['content']
    logger.warning(f'{provider["name"]} returned {resp.status_code}: {resp.text[:200]}')
    return None


def _call_gemini(provider, api_key, prompt, system_prompt, max_tokens, proxies, timeout=30):
    """Call Gemini REST API."""
    url = f'{provider["url"]}?key={api_key}'
    resp = requests.post(
        url,
        headers={'Content-Type': 'application/json'},
        json={
            'system_instruction': {'parts': [{'text': system_prompt}]},
            'contents': [{'parts': [{'text': prompt}]}],
            'generationConfig': {
                'maxOutputTokens': max_tokens,
                'temperature': 0.7,
            },
        },
        proxies=proxies or None,
        timeout=timeout,
    )
    if resp.status_code == 200:
        data = resp.json()
        candidates = data.get('candidates', [])
        if candidates:
            parts = candidates[0].get('content', {}).get('parts', [])
            if parts:
                return parts[0].get('text', '')
    logger.warning(f'Gemini returned {resp.status_code}: {resp.text[:200]}')
    return None


def _call_anthropic(provider, api_key, prompt, system_prompt, max_tokens, proxies, timeout=30):
    """Call Anthropic Claude API."""
    resp = requests.post(
        provider['url'],
        headers={
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
        },
        json={
            'model': provider['model'],
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': max_tokens,
        },
        proxies=proxies or None,
        timeout=timeout,
    )
    if resp.status_code == 200:
        data = resp.json()
        content = data.get('content', [])
        if content:
            return content[0].get('text', '')
    logger.warning(f'Claude returned {resp.status_code}: {resp.text[:200]}')
    return None


def call_ai_stream(prompt, system_prompt='你是一个专业的中国A股市场分析师。', max_tokens=2000, provider_order=None, custom_keys=None):
    """Streaming AI call — yields text chunks.
    DeepSeek supports native streaming; other providers simulate via chunked response."""
    proxies = {}
    if Config.HTTP_PROXY:
        proxies['http'] = Config.HTTP_PROXY
    if Config.HTTPS_PROXY:
        proxies['https'] = Config.HTTPS_PROXY

    ck = custom_keys or {}

    # Try DeepSeek streaming first (only if it's the first choice or no order specified)
    providers = _reorder_providers(provider_order)
    first_is_deepseek = providers and providers[0]['name'] == 'deepseek'

    api_key = ck.get('deepseek', '') or getattr(Config, 'DEEPSEEK_API_KEY', '')
    if api_key and first_is_deepseek:
        try:
            resp = requests.post(
                'https://api.deepseek.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                json={
                    'model': 'deepseek-chat',
                    'messages': [
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': prompt},
                    ],
                    'max_tokens': max_tokens,
                    'temperature': 0.7,
                    'stream': True,
                },
                proxies=proxies or None,
                timeout=60,
                stream=True,
            )
            if resp.status_code == 200:
                import json as _json
                for line in resp.iter_lines(decode_unicode=True):
                    if not line or not line.startswith('data: '):
                        continue
                    data_str = line[6:]
                    if data_str.strip() == '[DONE]':
                        return
                    try:
                        chunk = _json.loads(data_str)
                        delta = chunk.get('choices', [{}])[0].get('delta', {})
                        content = delta.get('content', '')
                        if content:
                            yield content
                    except (_json.JSONDecodeError, IndexError, KeyError):
                        continue
                return
            logger.warning(f'DeepSeek stream returned {resp.status_code}')
        except Exception as e:
            logger.warning(f'DeepSeek stream failed: {e}')

    # Fallback: get full response from call_ai and simulate streaming
    full_text = call_ai(prompt, system_prompt=system_prompt, max_tokens=max_tokens, provider_order=provider_order, custom_keys=custom_keys)
    if full_text:
        # Yield in ~20-char chunks to simulate streaming
        chunk_size = 20
        for i in range(0, len(full_text), chunk_size):
            yield full_text[i:i + chunk_size]


def generate_daily_brief(market_data, sentiment_data, research_data=None,
                         hot_events_data=None, policy_data=None):
    """Generate AI daily brief from 3 dimensions: market, hot events, policy."""
    # ── Dimension 1: Market context ──
    market_parts = []
    if market_data:
        indices_str = ', '.join([
            f"{idx['name']}: {idx['price']} ({idx['changePercent']:+.2f}%)"
            for idx in market_data.get('indices', [])
        ])
        market_parts.append(f'大盘指数: {indices_str}')
        ls = market_data.get('limitStats')
        if ls:
            market_parts.append(f'涨跌统计: {ls["up"]}涨/{ls["down"]}跌, 涨停{ls["limitUp"]}家/跌停{ls["limitDown"]}家')
        nb = market_data.get('northbound')
        if nb:
            market_parts.append(f'北向资金净流入: {nb["total"] / 1e8:.1f}亿')
        # Sector performance
        sectors = market_data.get('sectors', [])
        if sectors:
            top_sectors = sectors[:5]
            sectors_str = ', '.join([
                f"{s.get('name','')}: {s.get('changePercent',0):+.2f}%"
                for s in top_sectors
            ])
            market_parts.append(f'领涨板块: {sectors_str}')
            bottom_sectors = [s for s in sectors if s.get('changePercent', 0) < 0][-3:]
            if bottom_sectors:
                bottom_str = ', '.join([
                    f"{s.get('name','')}: {s.get('changePercent',0):+.2f}%"
                    for s in bottom_sectors
                ])
                market_parts.append(f'领跌板块: {bottom_str}')
        # Top gainers/losers
        gainers = market_data.get('topGainers', [])
        if gainers:
            g_str = ', '.join([f"{g['name']}({g['changePercent']:+.1f}%)" for g in gainers[:5]])
            market_parts.append(f'涨幅前五: {g_str}')
        losers = market_data.get('topLosers', [])
        if losers:
            l_str = ', '.join([f"{l['name']}({l['changePercent']:+.1f}%)" for l in losers[:5]])
            market_parts.append(f'跌幅前五: {l_str}')
    if sentiment_data:
        market_parts.append(f'市场情绪: {sentiment_data["label"]} (得分{sentiment_data["score"]})')
        # Sentiment factors
        factors = sentiment_data.get('factors', [])
        if factors:
            factors_str = '; '.join([f"{f['name']}:{f['score']}分" for f in factors[:4]])
            market_parts.append(f'情绪因子: {factors_str}')
    if research_data and research_data.get('reports'):
        top_reports = research_data['reports'][:5]
        reports_str = '\n'.join([f'- {r["title"]}({r["institution"]})' for r in top_reports])
        market_parts.append(f'重点研报:\n{reports_str}')

    # ── Dimension 2: Hot events context ──
    hot_parts = []
    if hot_events_data and hot_events_data.get('events'):
        events = hot_events_data['events']
        # Social hot topics
        social = [e for e in events if e.get('type') == 'social']
        if social:
            topics = '\n'.join([f'- {e["title"]}' for e in social[:8]])
            hot_parts.append(f'社交热搜:\n{topics}')
        # Market concept boards
        market_evts = [e for e in events if e.get('type') == 'market']
        if market_evts:
            concepts = '\n'.join([
                f'- {e["title"]}' + (f' ({e["changePercent"]:+.2f}%)' if e.get('changePercent') else '')
                for e in market_evts[:8]
            ])
            hot_parts.append(f'概念板块异动:\n{concepts}')
        # DB news events
        db_news = [e for e in events if e.get('type') == 'db-news']
        if db_news:
            news_titles = '\n'.join([f'- {e["title"]}' for e in db_news[:8]])
            hot_parts.append(f'重大新闻:\n{news_titles}')

    # ── Dimension 3: Policy context ──
    policy_parts = []
    if policy_data and policy_data.get('categories'):
        by_cat = policy_data['categories']
        # All relevant policy categories
        for cat in ['国务院', '财政货币', '金融监管', '央媒', '部委动态',
                    '统计', '外贸外交', '国际央行', '产业政策', '地方经济']:
            items = by_cat.get(cat, [])
            if items:
                titles = '\n'.join([f'  - {it["title"][:50]}' for it in items[:4]])
                policy_parts.append(f'【{cat}】\n{titles}')

    # ── Build prompt ──
    context_sections = []
    if market_parts:
        context_sections.append('【市场数据】\n' + '\n'.join(market_parts))
    if hot_parts:
        context_sections.append('【热点事件】\n' + '\n'.join(hot_parts))
    if policy_parts:
        context_sections.append('【政策动态】\n' + '\n'.join(policy_parts))

    context = '\n\n'.join(context_sections) if context_sections else '暂无数据'

    prompt = f"""基于以下三维度数据，生成一份专业、详实的每日投资简报。

{context}

请严格按以下结构输出（使用Markdown格式），三个维度都必须深入分析：

## 一、市场行情
分析要求：详细解读大盘走势（各指数涨跌原因），板块轮动特征（领涨/领跌板块逻辑），资金面变化（北向资金动向、成交量含义），个股异动分析（涨停跌停特征股）。3-4段，每段150-250字。

## 二、热点聚焦
分析要求：深度解读当前社交热搜话题对市场的情绪传导，概念板块异动的产业逻辑和催化因素，重大新闻事件的市场影响评估和持续性判断。3-4段，每段150-250字。

## 三、政策风向
分析要求：解读最新政策信号（财政/货币/产业政策），部委动态的行业影响，国际央行动向对国内市场的传导路径，政策面整体利好利空方向研判。3-4段，每段150-250字。

## 综合研判
分析要求：综合三维度信息，给出市场方向判断、板块配置建议、风险提示和操作策略。关注三维度交叉影响点（如政策利好+资金流入+热点催化的板块机会）。2-3段，每段150-250字。

要求：
- 直接从"## 一、市场行情"开头输出，不要加标题、日期、核心观点等前言内容
- 每个section必须以"## "开头（如"## 一、市场行情"），这是解析的关键标记
- 语言专业，分析深入，引用具体数据支撑论点
- 每个维度至少3段分析，不能流于表面
- 综合研判要给出具体可操作的投资建议
- 如某维度数据不足，可基于市场经验合理推演"""

    result = call_ai(prompt, max_tokens=4000)
    from datetime import datetime as dt
    now_iso = dt.now().isoformat()

    if result:
        sections = _parse_markdown_sections(result)
        return {
            'sections': sections,
            'generatedAt': now_iso,
            'timestamp': now_iso,
        }

    # Fallback static brief
    return {
        'sections': [
            {'title': '一、市场行情', 'content': '今日A股市场整体震荡整理，沪指窄幅波动，深成指和创业板指表现分化。成交量较前一交易日有所放大，显示市场参与意愿回升。板块方面，科技和新能源板块轮动活跃，金融板块表现相对平稳起到护盘作用。\n\n北向资金方面，沪股通和深股通资金流向出现分歧，反映外资对不同板块的配置偏好差异。涨停板数量维持在正常水平，跌停家数较少，市场赚钱效应尚可。整体来看，量能温和放大但尚未形成突破性合力，市场仍处于方向选择的关键窗口期。'},
            {'title': '二、热点聚焦', 'content': '科技板块表现活跃，半导体和AI概念持续领涨，产业链上下游个股联动明显。AI大模型应用端开始发力，相关软件和算力板块受到资金追捧。社交媒体热搜话题对相关概念股产生短期情绪扰动，但核心逻辑仍在于产业基本面改善。\n\n新能源赛道出现分化走势，光伏板块受海外政策扰动承压，而储能和新能源汽车板块在政策支持和销量数据改善预期下表现较强。消费板块整体弱势整理，等待即将公布的社零数据指引方向。'},
            {'title': '三、政策风向', 'content': '- 央行维持稳健货币政策基调，近期通过公开市场操作保持流动性合理充裕\n- 国务院常务会议部署多项稳增长措施，强调扩大内需和产业升级\n- 监管层持续强调防范系统性金融风险，加强资本市场投资者保护\n- 工信部推进新型工业化进程，发布多项产业扶持政策\n- 海外方面，美联储政策走向需持续关注，欧央行利率决议对全球市场产生外溢效应\n\n整体来看，国内政策面偏暖，财政和货币政策协同发力意图明显，对市场形成中长期支撑。'},
            {'title': '综合研判', 'content': '综合市场、热点和政策三个维度来看，当前A股处于震荡蓄势阶段。政策面持续偏暖为市场提供底部支撑，科技创新主线在AI产业浪潮推动下具备中长期投资价值，但短期需注意板块轮动节奏加快带来的操作难度。\n\n操作建议：保持6-7成仓位，重点关注三条主线：一是AI产业链中算力和应用端的优质标的；二是受益于政策支持的新型工业化相关板块；三是估值处于历史低位且基本面改善的消费龙头。同时注意控制个股仓位，设置止损线，规避短期涨幅过大的题材股回调风险。'},
        ],
        'generatedAt': now_iso,
        'timestamp': now_iso,
    }


def _parse_markdown_sections(md_text):
    """Parse markdown with ## headers into [{title, content}] sections.

    Handles multiple header formats:
    - ## 一、市场行情  (standard markdown)
    - 一、市场行情      (Chinese numbered without ##)
    - **一、市场行情**  (bold Chinese numbered)
    """
    import re
    sections = []
    current_title = None
    current_lines = []
    # Preamble lines before any section header (title/date/dividers)
    preamble = []

    # Pattern: line is a section header
    # Match: ## header, or standalone Chinese numbered section like 一、xxx / 二、xxx
    # Also match bold wrapped: **一、市场行情**
    section_re = re.compile(
        r'^(?:#{1,3}\s+)?'           # optional ## prefix
        r'(?:\*{1,2})?'              # optional bold **
        r'([一二三四五六七八九十]+、.+?'  # Chinese numbered: 一、xxx
        r'|综合研判.*?'               # or 综合研判
        r'|市场回顾.*?|热点解读.*?|风险提示.*?|明日展望.*?)'  # legacy
        r'(?:\*{1,2})?$'             # optional closing **
    )

    for line in md_text.split('\n'):
        stripped = line.strip()

        # Skip lines that are too long to be section headers (>60 chars = content, not header)
        if len(stripped) > 60 and not stripped.startswith('## '):
            if current_title is not None:
                current_lines.append(line)
            else:
                preamble.append(line)
            continue

        # Standard ## header
        if stripped.startswith('## '):
            if current_title is not None:
                sections.append({'title': current_title, 'content': '\n'.join(current_lines).strip()})
            current_title = stripped[3:].strip().strip('*')
            current_lines = []
            continue

        # Chinese numbered section header (without ##)
        m = section_re.match(stripped)
        if m and current_title is None and not sections:
            # First section header found — save preamble, start section
            current_title = m.group(1).strip('*').strip()
            current_lines = []
            continue
        elif m and current_title is not None:
            # New section
            sections.append({'title': current_title, 'content': '\n'.join(current_lines).strip()})
            current_title = m.group(1).strip('*').strip()
            current_lines = []
            continue

        if current_title is None:
            preamble.append(line)
        else:
            current_lines.append(line)

    if current_title is not None:
        sections.append({'title': current_title, 'content': '\n'.join(current_lines).strip()})

    # Strip preamble noise (title, date, dividers) from first section if no preamble consumed
    if sections and preamble:
        # Don't prepend preamble to sections — it's just meta info (title/date/dividers)
        pass

    if not sections:
        sections.append({'title': '投资简报', 'content': md_text.strip()})

    return sections


def analyze_mood_sentiment(posts):
    """Analyze sentiment of social media posts using keywords."""
    if not posts:
        return []

    positive_words = ['涨', '牛', '利好', '突破', '放量', '抄底', '机会', '看多', '加仓', '大涨', '暴涨', '反弹']
    negative_words = ['跌', '熊', '利空', '破位', '缩量', '割肉', '风险', '看空', '减仓', '暴跌', '崩', '恐慌']

    results = []
    for post in posts:
        text = post.get('content', '')
        pos_count = sum(1 for w in positive_words if w in text)
        neg_count = sum(1 for w in negative_words if w in text)

        if pos_count > neg_count:
            sentiment = '正面'
        elif neg_count > pos_count:
            sentiment = '负面'
        else:
            sentiment = '中性'

        post['sentiment'] = sentiment
        results.append(post)

    return results
