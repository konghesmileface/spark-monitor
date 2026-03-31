"""RAG engine: answers user questions with real-time market context injection.
Uses cache-first strategy: reads from Redis/memory cache populated by panel polling.
Injects: live indices, sentiment, policy news, research reports, conversation history."""

import json
import logging
from datetime import datetime
from services.ai_analysis import call_ai

logger = logging.getLogger('cn-intel.rag')


def _get_redis():
    """Get Redis instance from Flask app context."""
    try:
        from flask import current_app
        return current_app.redis
    except Exception:
        return None


def _cache_get(key):
    """Read from cache (Redis + memory). Same as services.cache but safe outside request."""
    try:
        from services.cache import cache_get
        return cache_get(key)
    except Exception:
        return None


def _get_brief_context():
    """Get the latest market brief text for RAG context."""
    try:
        from services.daily_brief import get_or_generate_brief
        brief = get_or_generate_brief(force=False)
        if brief and isinstance(brief, dict):
            sections = []
            if brief.get('summary'):
                sections.append(brief['summary'])
            if brief.get('market'):
                sections.append(str(brief['market'])[:500])
            return '\n'.join(sections)[:1000]
        if brief and isinstance(brief, str):
            return brief[:1000]
    except Exception as e:
        logger.warning(f'Failed to get brief for RAG context: {e}')
    return ''


def _format_market_data(data):
    """Format market overview dict into text lines."""
    lines = []
    for idx in data.get('indices', []):
        sign = '+' if idx.get('changePercent', 0) > 0 else ''
        lines.append(f"{idx.get('name', '')} {idx.get('price', 0):.2f} {sign}{idx.get('changePercent', 0):.2f}%")
    nb = data.get('northbound', {})
    if nb.get('total'):
        total_yi = nb['total'] / 1e4
        lines.append(f"北向资金净流入 {total_yi:.1f}亿")
    ls = data.get('limitStats', {})
    if ls.get('up') or ls.get('down'):
        lines.append(f"涨停{ls.get('limitUp', 0)} 跌停{ls.get('limitDown', 0)} 上涨{ls.get('up', 0)} 下跌{ls.get('down', 0)}")
    sectors = data.get('sectors', [])[:5]
    if sectors:
        sec_parts = [f"{s['name']}{'+' if s['changePercent'] > 0 else ''}{s['changePercent']:.1f}%" for s in sectors]
        lines.append(f"领涨板块: {', '.join(sec_parts)}")
    gainers = data.get('topGainers', [])[:3]
    losers = data.get('topLosers', [])[:3]
    if gainers:
        g_parts = [f"{g['name']}+{g['changePercent']:.1f}%" for g in gainers]
        lines.append(f"涨幅前三: {', '.join(g_parts)}")
    if losers:
        l_parts = [f"{l['name']}{l['changePercent']:.1f}%" for l in losers]
        lines.append(f"跌幅前三: {', '.join(l_parts)}")
    return '\n'.join(lines)


def _get_market_context():
    """Get market data — cache-first, fallback to live API."""
    # Try cache first (populated by CnMarketPanel polling every 120s)
    cached = _cache_get('cn:market:overview')
    if cached:
        return _format_market_data(cached)

    # Fallback: live fetch (slower, ~3s)
    try:
        from services.akshare_data import get_market_overview
        data = get_market_overview()
        return _format_market_data(data)
    except Exception as e:
        logger.warning(f'RAG: market context failed: {e}')
        return ''


def _get_sentiment_context():
    """Get sentiment data — cache-first, fallback to live API."""
    # Try cache first (populated by CnSentimentPanel polling every 300s)
    cached = _cache_get('cn:sentiment:index')
    if cached:
        return _format_sentiment(cached)

    # Fallback: live fetch
    try:
        from services.akshare_data import get_sentiment_data
        data = get_sentiment_data()
        return _format_sentiment(data)
    except Exception as e:
        logger.warning(f'RAG: sentiment context failed: {e}')
        return ''


def _format_sentiment(data):
    """Format sentiment dict into text."""
    lines = [f"情绪指数: {data.get('score', 50)}/100 ({data.get('label', '中性')})"]
    for f in data.get('factors', []):
        lines.append(f"  {f['name']}: {f['score']} - {f.get('detail', '')}")
    return '\n'.join(lines)


def _get_policy_context(question):
    """Get policy news for RAG context.
    Strategy: 1) keyword search in MySQL policy_store
              2) fallback to cached gov-news from Redis (crawled by panel)."""
    import re
    sources = []
    lines = []

    # Strategy 1: Search MySQL policy_store by question keywords
    try:
        from services.policy_store import search_items
        keywords = re.findall(r'[\u4e00-\u9fff]{2,4}', question)
        if keywords:
            seen_titles = set()
            for kw in keywords[:3]:
                items = search_items(kw, limit=5)
                for item in items:
                    if item['title'] not in seen_titles:
                        seen_titles.add(item['title'])
                        date_str = item.get('date', '')
                        source = item.get('source', '')
                        lines.append(f"[{date_str}] {source}: {item['title']}")
                        if source and source not in sources:
                            sources.append(source)
            if lines:
                return '\n'.join(lines[:10]), sources
    except Exception as e:
        logger.warning(f'RAG: policy_store search failed: {e}')

    # Strategy 2: Fallback to cached gov-news (populated by /api/cn/gov-news polling)
    try:
        cached = _cache_get('cn:gov-news')
        if cached and cached.get('categories'):
            for cat, items in cached['categories'].items():
                for item in (items or [])[:3]:
                    title = item.get('title', '')
                    source = item.get('source', '')
                    if title and title not in {l.split(': ', 1)[-1] for l in lines}:
                        lines.append(f"[{cat}] {source}: {title}")
                        if source and source not in sources:
                            sources.append(source)
            if lines:
                return '\n'.join(lines[:12]), sources
    except Exception as e:
        logger.warning(f'RAG: cached gov-news fallback failed: {e}')

    return '', []


def _get_report_context():
    """Get recent research reports from MySQL database."""
    try:
        from services.akshare_data import get_db_research_reports
        data = get_db_research_reports(page=1, page_size=10)
        reports = data.get('reports', [])
        if not reports:
            return '', []

        lines = []
        sources = []
        for r in reports[:10]:
            inst = r.get('institution', '')
            title = r.get('title', '')
            date_str = r.get('date', '')
            summary = r.get('summary', '')
            line = f"[{date_str}] {inst}: {title}"
            if summary:
                line += f" — {summary[:100]}"
            lines.append(line)
            if inst and inst not in sources:
                sources.append(inst)
        return '\n'.join(lines), sources
    except Exception as e:
        logger.warning(f'RAG: report context failed: {e}')
        return '', []


def _get_uploaded_report_context(max_reports=3):
    """Get summaries from user-uploaded PDF reports."""
    import os
    sources = []
    try:
        from config import Config
        upload_dir = Config.UPLOAD_FOLDER
        if not os.path.isdir(upload_dir):
            return '', []

        analysis_files = sorted(
            [f for f in os.listdir(upload_dir) if f.endswith('.analysis.json')],
            reverse=True
        )

        summaries = []
        for fname in analysis_files[:max_reports]:
            path = os.path.join(upload_dir, fname)
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                analysis = data.get('analysis', {})
                title = analysis.get('title', data.get('filename', fname))
                summary = analysis.get('summary', '')
                core_views = analysis.get('coreViews', [])
                if summary or core_views:
                    text = f'[{title}] {summary}'
                    if core_views:
                        text += ' 核心观点: ' + '; '.join(core_views[:3])
                    summaries.append(text)
                    sources.append(title)
            except Exception:
                continue

        return '\n'.join(summaries), sources
    except Exception as e:
        logger.warning(f'RAG: uploaded reports failed: {e}')
    return '', []


def _get_hot_events_context():
    """Get top hot events from cache for RAG context (source 8)."""
    try:
        cached = _cache_get('cn:hot-events:latest')
        if not cached:
            return '', []
        events = cached.get('events', [])[:8]
        if not events:
            return '', []
        lines = []
        for ev in events:
            title = ev.get('title', '')
            impact = ev.get('impact', '')
            keywords = ev.get('keywords', [])
            stocks = ev.get('related_stocks', [])
            line = title
            if impact:
                line += f' — {impact[:60]}'
            if keywords:
                line += f' [{",".join(keywords[:4])}]'
            if stocks:
                line += f' 相关: {",".join(s if isinstance(s, str) else s.get("name","") for s in stocks[:3])}'
            lines.append(line)
        return '\n'.join(lines), ['热点事件']
    except Exception as e:
        logger.warning(f'RAG: hot events context failed: {e}')
        return '', []


def _get_mood_context():
    """Get social mood summary from cache for RAG context (source 9)."""
    try:
        cached = _cache_get('cn:mood:social')
        if not cached:
            return '', []
        lines = []
        # Distribution
        dist = cached.get('distribution', {})
        if dist:
            lines.append(f'舆情分布: 正面{dist.get("positive",0)} 负面{dist.get("negative",0)} 中性{dist.get("neutral",0)}')
        # Keywords
        keywords = cached.get('keywords', [])
        if keywords:
            kw_str = ', '.join(k.get('word', k) if isinstance(k, dict) else str(k) for k in keywords[:10])
            lines.append(f'社交热词: {kw_str}')
        # Active platforms
        platforms = cached.get('platforms', {})
        if platforms:
            active = [f'{name}({len(posts)}条)' for name, posts in platforms.items() if posts][:5]
            if active:
                lines.append(f'活跃平台: {", ".join(active)}')
        if not lines:
            return '', []
        return '\n'.join(lines), ['社交舆情']
    except Exception as e:
        logger.warning(f'RAG: mood context failed: {e}')
        return '', []


def _load_chat_history(session_id, max_turns=3):
    """Load recent conversation turns from Redis.
    For long conversations (>6 turns), prepends a summary of earlier context."""
    r = _get_redis()
    if not r or not session_id:
        return ''
    try:
        key = f'cn:rag:history:{session_id}'
        total = r.llen(key)
        items = r.lrange(key, -max_turns * 2, -1)  # last N turns (Q+A pairs)
        if not items:
            return ''

        lines = []

        # For long conversations, prepend summary of earlier messages
        if total > 6:
            summary_key = f'cn:rag:summary:{session_id}'
            summary = r.get(summary_key)
            if summary:
                if isinstance(summary, bytes):
                    summary = summary.decode('utf-8')
                lines.append(f'[对话摘要] {summary}')

        for item in items:
            try:
                msg = json.loads(item)
                role = '用户' if msg.get('role') == 'user' else '助手'
                lines.append(f"{role}: {msg['content'][:200]}")
            except Exception:
                continue
        return '\n'.join(lines)
    except Exception as e:
        logger.warning(f'RAG: load history failed: {e}')
        return ''


def _save_chat_history(session_id, role, content):
    """Save a message to conversation history in Redis.
    Every 3 user turns, generate a lightweight conversation summary."""
    r = _get_redis()
    if not r or not session_id:
        return
    try:
        key = f'cn:rag:history:{session_id}'
        msg = json.dumps({'role': role, 'content': content[:500]}, ensure_ascii=False)
        r.rpush(key, msg)
        r.ltrim(key, -20, -1)  # Keep last 20 messages (10 turns)
        r.expire(key, 86400)  # 24 hour TTL (extended from 1h)

        # Every 3 user messages, generate and cache a conversation summary
        if role == 'user':
            count_key = f'cn:rag:turn_count:{session_id}'
            turn_count = r.incr(count_key)
            r.expire(count_key, 86400)
            if turn_count % 3 == 0:
                _generate_conversation_summary(r, session_id)
    except Exception as e:
        logger.warning(f'RAG: save history failed: {e}')


def _generate_conversation_summary(r, session_id):
    """Generate a compact summary of the conversation so far.
    Stored in cn:rag:summary:{session_id}, used for long conversations."""
    try:
        key = f'cn:rag:history:{session_id}'
        items = r.lrange(key, 0, -1)
        if not items or len(items) < 4:
            return

        lines = []
        for item in items:
            try:
                msg = json.loads(item)
                role = '用户' if msg.get('role') == 'user' else '助手'
                lines.append(f"{role}: {msg['content'][:150]}")
            except Exception:
                continue

        conversation_text = '\n'.join(lines[-12:])  # Last 6 turns
        prompt = f"""请用3-4句话概括以下对话的核心内容和讨论方向，保留关键数据和结论：

{conversation_text}

输出简洁摘要（中文，100字以内）："""

        summary = call_ai(prompt, system_prompt='你是对话摘要助手，用极简方式概括对话要点。', max_tokens=200)
        if summary:
            summary_key = f'cn:rag:summary:{session_id}'
            r.setex(summary_key, 86400, summary)
            logger.warning(f'RAG: generated conversation summary for {session_id}')
    except Exception as e:
        logger.warning(f'RAG: summary generation failed: {e}')


def _classify_question_topics(question):
    """Classify question into topic categories for selective context injection.
    Returns a set of topic keys: market, sentiment, policy, research, hot_events, mood."""
    topics = set()
    q = question.lower()

    # Market data keywords
    if any(kw in q for kw in ['大盘', '指数', '上证', '深证', '创业板', '科创', '北向',
                                '涨停', '跌停', '行情', '涨跌', '板块', '龙头', '个股',
                                '资金', '成交', '量能', '缩量', '放量', '股价', '走势']):
        topics.add('market')

    # Sentiment keywords
    if any(kw in q for kw in ['情绪', '恐慌', '贪婪', '牛市', '熊市', '恐惧',
                                '乐观', '悲观', '信心', '预期']):
        topics.add('sentiment')

    # Policy keywords
    if any(kw in q for kw in ['政策', '央行', '降息', '降准', '利率', '监管', '发改委',
                                '国务院', '财政', '货币', '两会', '国资', '减税',
                                '证监会', '银监', '金监', '改革', '制裁', '关税']):
        topics.add('policy')

    # Research keywords
    if any(kw in q for kw in ['研报', '报告', '分析师', '机构', '研究', '评级',
                                '目标价', '推荐', '研究所', '券商']):
        topics.add('research')

    # Hot events keywords
    if any(kw in q for kw in ['热点', '概念', '题材', '风口', '热搜', '事件',
                                '新闻', '突发', '利好', '利空', '消息']):
        topics.add('hot_events')

    # Mood / sentiment keywords
    if any(kw in q for kw in ['舆情', '舆论', '社交', '微博', '讨论', '散户',
                                '雪球', '吧友', '股吧', '知乎', '热议', '口碑']):
        topics.add('mood')

    # If no specific topic detected, inject core contexts
    if not topics:
        topics = {'market', 'hot_events', 'sentiment'}

    return topics


def ask_question(question, session_id=None):
    """Answer investment questions with topic-aware context injection.
    Uses _classify_question_topics() to select relevant context layers,
    saving 40-60% tokens while improving answer relevance."""

    # Classify question to determine which context to inject
    topics = _classify_question_topics(question)
    logger.warning(f'RAG topics for "{question[:30]}": {topics}')

    # Build context from multiple data sources
    context_parts = []
    all_sources = []

    # 1. Real-time market data — always inject (compact, essential)
    market_text = _get_market_context()
    if market_text:
        context_parts.append(f'【实时行情】\n{market_text}')

    # 2. Sentiment data — inject if market/sentiment topic
    if topics & {'market', 'sentiment'}:
        sentiment_text = _get_sentiment_context()
        if sentiment_text:
            context_parts.append(f'【市场情绪】\n{sentiment_text}')

    # 3. Policy news — inject if policy topic
    if 'policy' in topics:
        policy_text, policy_sources = _get_policy_context(question)
        if policy_text:
            context_parts.append(f'【相关政策新闻】\n{policy_text}')
            all_sources.extend(policy_sources)

    # 4. Research reports from DB — inject if research topic
    if 'research' in topics:
        report_text, report_sources = _get_report_context()
        if report_text:
            context_parts.append(f'【近期研报】\n{report_text}')
            all_sources.extend(report_sources)

    # 5. Uploaded PDF reports — inject if research topic
    if 'research' in topics:
        uploaded_text, uploaded_sources = _get_uploaded_report_context()
        if uploaded_text:
            context_parts.append(f'【上传研报分析】\n{uploaded_text}')
            all_sources.extend(uploaded_sources)

    # 6. Conversation history — always inject
    history_text = _load_chat_history(session_id)
    if history_text:
        context_parts.append(f'【对话历史】\n{history_text}')

    # 7. Hot events — inject if hot_events or market topic
    if topics & {'hot_events', 'market'}:
        hot_text, hot_sources = _get_hot_events_context()
        if hot_text:
            context_parts.append(f'【今日热点事件】\n{hot_text}')
            all_sources.extend(hot_sources)

    # 8. Social mood — inject if mood topic
    if 'mood' in topics:
        mood_text, mood_sources = _get_mood_context()
        if mood_text:
            context_parts.append(f'【社交舆情】\n{mood_text}')
            all_sources.extend(mood_sources)

    context_block = '\n\n'.join(context_parts) if context_parts else '暂无实时数据。'

    system_prompt = f"""你是一个专业的中国A股投资研究助手，拥有实时市场数据访问能力。

{context_block}

要求：
1. 优先引用上述实时行情、研报、政策、热点事件和舆情数据来回答
2. 回答专业、客观、有数据支撑，用具体数字说话
3. 在关键数据后用方括号标注来源，如 [行情:上证] [研报:中信] [政策:央行] [舆情:微博] [热点:xx]
4. 如有必要，提示投资风险
5. 使用中文回答
6. 回答控制在500字以内
7. 如果引用了研报或新闻来源，请在回答末尾注明"""

    # Save user question to history
    _save_chat_history(session_id, 'user', question)

    # Try agent loop first (tool-calling enabled), fallback to plain call_ai
    try:
        from services.agent_loop import run as agent_run
        agent_result = agent_run(
            question=question,
            context=context_block,
            max_turns=4,
            system_prompt=system_prompt,
        )
        answer = agent_result.get('answer', '')
        # Merge agent tool sources with context sources
        agent_sources = agent_result.get('sources', [])
        all_sources.extend(agent_sources)
        tools_used = agent_result.get('toolsUsed', [])
        if tools_used:
            logger.warning(f'RAG agent used tools: {tools_used}')
    except Exception as e:
        logger.warning(f'RAG agent loop failed, falling back to plain call_ai: {e}')
        answer = None

    if not answer:
        # Legacy fallback: plain call_ai
        answer = call_ai(question, system_prompt=system_prompt, max_tokens=2000)

    if not answer:
        answer = f'抱歉，AI服务暂时不可用。您的问题 "{question}" 已记录。\n\n建议您查看研报或行情数据获取相关信息。'

    # Save assistant answer to history
    _save_chat_history(session_id, 'assistant', answer)

    # Deduplicate sources
    unique_sources = list(dict.fromkeys(all_sources))

    return {
        'question': question,
        'answer': answer,
        'sources': unique_sources[:10],
        'timestamp': datetime.now().isoformat()
    }
