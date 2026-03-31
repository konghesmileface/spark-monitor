import os
import json
import logging
import tempfile
import requests as req
from flask import Blueprint, jsonify, request
from services.akshare_data import get_research_reports, get_db_research_reports, get_db_report_detail, get_db_news_articles, get_db_news_detail, search_db_research_reports
from services.cache import cache_get, cache_set
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.research')

research_bp = Blueprint('research', __name__)

_PDF_SERVER = 'http://8.133.16.112/pdfs/'
_TIMEOUT = 15
_GENERIC_KW = {'研究报告', '研究', '报告', '年', '分析', '研报', '行业', '行业研究',
               '市场', '中国', '国内', '全球', '深度', '专题', '系列', '跟踪',
               '2020年', '2021年', '2022年', '2023年', '2024年', '2025年', '2026年'}


@research_bp.route('/api/cn/research')
@safe_route(cache_key='cn:research:reports')
def cn_research():
    cache_key = 'cn:research:reports'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    data = get_research_reports()
    cache_set(cache_key, data, 3600)
    return jsonify(data)


@research_bp.route('/api/cn/research/pdfs')
def cn_research_pdfs():
    """List PDF reports from external research server."""
    cache_key = 'cn:research:pdfs'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    pdfs = []
    try:
        resp = req.get(_PDF_SERVER, timeout=_TIMEOUT,
                       headers={'User-Agent': 'Mozilla/5.0'})
        if resp.ok:
            # Parse HTML directory listing for <a href="xxx.pdf">
            import re
            # Match href="filename.pdf" patterns (Apache/Nginx directory listing)
            links = re.findall(r'href="([^"]+\.pdf)"', resp.text, re.IGNORECASE)
            # Also try to extract dates from directory listing
            # Common format: <td>2026-03-10 12:34</td> or date in the same line
            lines = resp.text.split('\n')
            date_map = {}
            for line in lines:
                pdf_match = re.search(r'href="([^"]+\.pdf)"', line, re.IGNORECASE)
                if pdf_match:
                    fname = pdf_match.group(1)
                    # Try to find date in the same line
                    date_match = re.search(r'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})', line)
                    if date_match:
                        date_map[fname] = date_match.group(1)
                    # Try alternative format: DD-Mon-YYYY HH:MM
                    elif not date_match:
                        alt = re.search(r'(\d{2}-\w{3}-\d{4}\s+\d{2}:\d{2})', line)
                        if alt:
                            date_map[fname] = alt.group(1)

            for fname in links:
                pdfs.append({
                    'filename': fname,
                    'url': f'{_PDF_SERVER}{fname}',
                    'date': date_map.get(fname, ''),
                })

            # Sort: newest first (by date if available, else by name descending)
            pdfs.sort(key=lambda x: x.get('date', x['filename']), reverse=True)
    except Exception as e:
        logger.warning(f'Failed to fetch PDF list: {e}')

    result = {'pdfs': pdfs, 'server': _PDF_SERVER}
    cache_set(cache_key, result, 1800)
    return jsonify(result)


@research_bp.route('/api/cn/research/db')
def cn_research_db():
    """Get research reports from remote MySQL database."""
    page = request.args.get('page', 1, type=int)
    page_size = request.args.get('pageSize', 30, type=int)
    keyword = request.args.get('keyword', '', type=str).strip()
    doc_type = request.args.get('type', 'all', type=str).strip()
    if doc_type not in ('all', '04', '05'):
        doc_type = 'all'

    # Clamp page_size
    page_size = max(10, min(page_size, 100))

    cache_key = f'cn:research:db:p{page}:s{page_size}:k{keyword}:t{doc_type}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    try:
        data = get_db_research_reports(page=page, page_size=page_size, keyword=keyword, doc_type=doc_type)
        cache_set(cache_key, data, 600)  # 10min cache
        return jsonify(data)
    except Exception as e:
        logger.warning(f'research/db failed: {e}')
        return jsonify({'reports': [], 'total': 0, 'error': str(e), '_stale': True})


@research_bp.route('/api/cn/research/analyze-remote', methods=['POST'])
def cn_research_analyze_remote():
    """Download a PDF from the external server and analyze it with AI."""
    data = request.get_json(silent=True) or {}
    url = data.get('url', '')

    # Security: only allow URLs from our known PDF server
    if not url.startswith(_PDF_SERVER):
        return jsonify({'error': '不允许的URL', 'success': False}), 400

    try:
        # Download PDF to temp file
        resp = req.get(url, timeout=30,
                       headers={'User-Agent': 'Mozilla/5.0'})
        if not resp.ok:
            return jsonify({'error': f'下载失败: HTTP {resp.status_code}', 'success': False}), 502

        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            tmp.write(resp.content)
            tmp_path = tmp.name

        logger.warning(f'Analyzing remote PDF: {url} ({len(resp.content)} bytes)')

        # Analyze using existing function
        result = analyze_pdf(tmp_path)

        # Cleanup
        try:
            os.remove(tmp_path)
        except Exception:
            pass

        return jsonify(result)
    except Exception as e:
        logger.warning(f'Failed to analyze remote PDF: {e}')
        return jsonify({'error': f'分析失败: {str(e)}', 'success': False}), 500


@research_bp.route('/api/cn/research/db/detail')
@safe_route()
def cn_research_db_detail():
    """Get full report detail (no macro_array truncation).
    For type=05 (自媒体) with empty content, auto-fetches from WeChat URL."""
    report_id = request.args.get('id', '', type=str).strip()
    if not report_id:
        return jsonify({'error': '缺少id参数'}), 400

    cache_key = f'cn:research:detail:{report_id}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    detail = get_db_report_detail(report_id)
    if not detail:
        return jsonify({'error': '研报不存在'}), 404

    # Auto-fetch WeChat content for 自媒体 (type 05) when macro_array is empty
    if detail.get('type') == '05' and not detail.get('content', '').strip():
        link = detail.get('link', '')
        if link and 'mp.weixin.qq.com' in link:
            from services.wechat_fetcher import fetch_wechat_article
            wechat = fetch_wechat_article(link)
            if wechat:
                detail['content'] = wechat['content']
                detail['plainText'] = wechat['plainText']

    cache_set(cache_key, detail, 1800)  # 30min cache
    return jsonify(detail)


@research_bp.route('/api/cn/research/analyze', methods=['POST'])
def cn_research_analyze():
    """AI-analyze a database research report."""
    data = request.get_json(silent=True) or {}
    report_id = data.get('id', '').strip()
    if not report_id:
        return jsonify({'error': '缺少id参数'}), 400

    # Check cache
    cache_key = f'cn:research:analysis:{report_id}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    # Fetch report from DB
    detail = get_db_report_detail(report_id)

    # Fallback for external reports (e.g. eastmoney) — use request body metadata
    if not detail:
        summary = data.get('summary', '').strip()
        title = data.get('title', '').strip()
        if summary or title:
            detail = {
                'title': title,
                'institution': data.get('institution', ''),
                'date': data.get('date', ''),
                'plainText': summary,
            }
        else:
            return jsonify({'error': '研报不存在'}), 404

    # Auto-fetch WeChat content for 自媒体
    if detail.get('type') == '05' and not detail.get('plainText', '').strip():
        link = detail.get('link', '')
        if link and 'mp.weixin.qq.com' in link:
            from services.wechat_fetcher import fetch_wechat_article
            wechat = fetch_wechat_article(link)
            if wechat:
                detail['content'] = wechat['content']
                detail['plainText'] = wechat['plainText']

    plain_text = detail.get('plainText', '')
    title = detail.get('title', '')
    institution = detail.get('institution', '')
    date_str = detail.get('date', '')
    is_media = detail.get('type') == '05'

    # 自媒体 with short/no content: AI analyzes based on title + institution
    if is_media and len(plain_text) < 20 and len(title) >= 4:
        from services.ai_analysis import call_ai
        prompt = f"""你是一位资深金融分析师。请基于以下自媒体文章的标题和来源，分析该文章可能讨论的核心内容，给出专业解读。

文章标题：{title}
发布机构/自媒体：{institution}
发布日期：{date_str}
摘要：{plain_text if plain_text else '无'}

请基于你的专业知识，对该标题所涉及的话题进行深入分析。输出JSON格式（不要添加markdown代码块标记）：
{{
  "title": "{title}",
  "institution": "{institution}",
  "coreViews": ["基于标题推断的核心观点1", "核心观点2", "核心观点3"],
  "rating": "无评级",
  "riskFactors": ["相关风险因素1", "风险因素2"],
  "relatedStocks": ["相关标的（如有）"],
  "summary": "基于标题和行业知识的200字深度解读",
  "investmentLogic": "相关投资逻辑",
  "marketImpact": "对市场的潜在影响"
}}"""
        result_text = call_ai(prompt, system_prompt='你是一位资深券商研究员，擅长基于有限信息推断文章核心观点并给出专业解读。', max_tokens=2000)
    elif len(plain_text) < 20:
        return jsonify({'error': '研报内容太短，无法分析'}), 400
    else:
        # Normal analysis with full content
        from services.ai_analysis import call_ai
        prompt = f"""请对以下研报进行结构化分析，以JSON格式输出：

研报标题：{title}
发布机构：{institution}
发布日期：{date_str}

研报内容（摘要）：
{plain_text[:12000]}

请严格按以下JSON格式输出（不要添加markdown代码块标记）：
{{
  "title": "研报标题",
  "institution": "发布机构",
  "coreViews": ["核心观点1", "核心观点2", "核心观点3"],
  "rating": "买入/增持/中性/减持/卖出/无评级",
  "riskFactors": ["风险因素1", "风险因素2"],
  "relatedStocks": ["相关标的1", "相关标的2"],
  "summary": "200字以内的核心摘要",
  "investmentLogic": "投资逻辑简述",
  "marketImpact": "对市场的影响分析"
}}"""
        result_text = call_ai(prompt, system_prompt='你是一个专业的券商研报分析师。请严格输出JSON。', max_tokens=2000)

    if not result_text:
        return jsonify({'error': 'AI分析失败，请稍后重试'}), 500

    # Parse JSON (handle markdown code blocks)
    try:
        cleaned = result_text.strip()
        if cleaned.startswith('```'):
            # Remove ```json ... ```
            lines = cleaned.split('\n')
            cleaned = '\n'.join(lines[1:-1] if lines[-1].strip() == '```' else lines[1:])
        analysis = json.loads(cleaned)
    except json.JSONDecodeError:
        analysis = {
            'title': detail.get('title', ''),
            'institution': detail.get('institution', ''),
            'summary': result_text[:500],
            'coreViews': [],
            'rating': '无评级',
            'riskFactors': [],
            'relatedStocks': [],
        }

    cache_set(cache_key, analysis, 3600)  # 1h cache
    return jsonify(analysis)


@research_bp.route('/api/cn/news/db')
def cn_news_db():
    """Get news articles (综合新闻/监管/金融处罚/央行动态) from remote MySQL for 舆情 panel."""
    page = request.args.get('page', 1, type=int)
    page_size = request.args.get('pageSize', 30, type=int)
    keyword = request.args.get('keyword', '', type=str).strip()
    news_type = request.args.get('type', 'all', type=str).strip()
    if news_type not in ('all', '0', '01', '02', '03'):
        news_type = 'all'

    page_size = max(10, min(page_size, 100))

    cache_key = f'cn:news:db:p{page}:s{page_size}:k{keyword}:t{news_type}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    try:
        data = get_db_news_articles(page=page, page_size=page_size, keyword=keyword, news_type=news_type)
        cache_set(cache_key, data, 600)
        return jsonify(data)
    except Exception as e:
        logger.warning(f'news/db failed: {e}')
        return jsonify({'articles': [], 'total': 0, 'error': str(e), '_stale': True})


@research_bp.route('/api/cn/news/db/detail')
@safe_route()
def cn_news_db_detail():
    """Get full news article detail (with macro_array content)."""
    article_id = request.args.get('id', '', type=str).strip()
    if not article_id:
        return jsonify({'error': '缺少id参数'}), 400

    cache_key = f'cn:news:detail:{article_id}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    detail = get_db_news_detail(article_id)
    if not detail:
        return jsonify({'error': '新闻不存在'}), 404

    cache_set(cache_key, detail, 1800)  # 30min cache
    return jsonify(detail)


@research_bp.route('/api/cn/research/chat', methods=['POST'])
@safe_route()
def cn_research_chat():
    """Chat with AI about a research report (with tool-calling agent loop)."""
    data = request.get_json(silent=True) or {}
    report_id = data.get('reportId', '').strip()
    question = data.get('question', '').strip()
    history = data.get('history', [])

    if not question:
        return jsonify({'error': '缺少question参数'}), 400

    # Load report context (try cached detail first, which may have WeChat-fetched content)
    context = ''
    if report_id:
        cached_detail = cache_get(f'cn:research:detail:{report_id}')
        detail = cached_detail or get_db_report_detail(report_id)
        if detail:
            plain = detail.get('plainText', '')
            title = detail.get('title', '')
            institution = detail.get('institution', '')
            # 自媒体 with no content: provide title-based context
            if detail.get('type') == '05' and not plain.strip():
                context = f"文章标题：{title}\n来源：{institution}\n\n注意：该文章来自微信公众号，无法获取全文。请基于标题和你的专业知识来回答用户问题。"
            else:
                context = f"研报标题：{title}\n机构：{institution}\n\n{plain}"
        else:
            # Fallback for external reports (e.g. eastmoney) — use request body metadata
            title = data.get('title', '')
            institution = data.get('institution', '')
            summary = data.get('summary', '')
            if title or summary:
                context = f"研报标题：{title}\n机构：{institution}\n\n{summary}"

    # Run agent loop
    from services.agent_loop import run
    result = run(question=question, context=context, history=history)
    return jsonify(result)


# ── Research Transmission Chain ──────────────────────────────────────────────

@research_bp.route('/api/cn/research/transmission-chain', methods=['POST'])
@safe_route()
def cn_research_transmission_chain():
    """Build a 5-level DAG transmission chain for a research report.
    Body JSON: { title, content? }
    Returns: { nodes, edges, summary }"""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()

    if not title:
        return jsonify({'error': '缺少title参数'}), 400

    from services.policy_chains import build_transmission_chain
    result = build_transmission_chain(title, content)
    return jsonify(result)


# ── Research Timeline (脉络) ─────────────────────────────────────────────────

@research_bp.route('/api/cn/research/timeline', methods=['POST'])
@safe_route()
def cn_research_timeline():
    """Build a research topic evolution timeline.
    Body JSON: { title, topic? }
    Searches the research DB for related reports, then AI analyzes evolution.
    Returns: { topic, events, inflection_points, overall_trend, current_phase }"""
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    topic = data.get('topic', '').strip()

    if not title and not topic:
        return jsonify({'error': '缺少title或topic参数'}), 400

    search_topic = topic or title
    import hashlib
    tl_hash = hashlib.md5(search_topic.encode()).hexdigest()
    tl_cache_key = f'cn:research:timeline:{tl_hash}'
    cached = cache_get(tl_cache_key)
    if cached:
        return jsonify(cached)

    # Extract keywords using AI, filter out generic terms
    from api.gov_news import _ai_extract_search_keywords
    raw_kw = _ai_extract_search_keywords(search_topic)
    keywords = [k for k in (raw_kw or []) if k not in _GENERIC_KW and len(k) >= 2]
    if not keywords:
        # Fallback: extract meaningful segments from title (skip year/generic)
        import re
        cleaned_title = re.sub(r'\d{4}\s*年?', '', search_topic)
        for term in _GENERIC_KW:
            cleaned_title = cleaned_title.replace(term, '')
        cleaned_title = cleaned_title.strip()
        if len(cleaned_title) >= 2:
            keywords = [cleaned_title[:8]] if len(cleaned_title) > 8 else [cleaned_title]
        else:
            keywords = [search_topic[:8]]

    logger.warning(f'timeline keywords for "{search_topic}": {keywords}')

    # Search research DB
    items = search_db_research_reports(keywords, limit=60)

    if not items:
        return jsonify({
            'topic': search_topic,
            'events': [],
            'inflection_points': [],
            'overall_trend': '数据库中未找到相关研报记录',
            'current_phase': '',
        })

    # Build title list for AI to analyze (cap at 30 for speed)
    title_list = '\n'.join([f"- [{it['date']}] {it['title']} ({it.get('source','')})" for it in items[:30]])

    from services.ai_analysis import call_ai
    prompt = f"""分析以下研报主题的历史演变脉络：

主题关键词：{search_topic}

相关研报列表（按时间倒序）：
{title_list}

请从中选出15-25个最具代表性的关键节点，分析研究观点的变化。以JSON格式返回（不要markdown代码块）：
{{
  "events": [
    {{"date": "YYYY-MM-DD", "title": "研报标题", "direction": "松/紧/中性", "significance": "高/中/低", "summary": "20字内概述"}}
  ],
  "inflection_points": [
    {{"date": "YYYY-MM-DD", "title": "转折点研报", "from_direction": "松/紧/中性", "to_direction": "松/紧/中性", "reason": "30字内原因"}}
  ],
  "overall_trend": "总体趋势描述（50字以内）",
  "current_phase": "当前研究共识所处阶段描述（30字以内）"
}}

注意：direction用"松"表示看多/乐观/利好，"紧"表示看空/悲观/利空，"中性"表示观望/不变。"""

    result_text = call_ai(
        prompt,
        system_prompt='你是中国金融研报演变分析专家。精准判断每个研报的观点方向（松/紧/中性），找出关键转折点。',
        max_tokens=2000,
    )

    result = {
        'topic': search_topic,
        'events': [],
        'inflection_points': [],
        'overall_trend': '',
        'current_phase': '',
        'total_items': len(items),
    }

    if result_text:
        try:
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            parsed = json.loads(cleaned.strip())
            result['events'] = parsed.get('events', [])
            result['inflection_points'] = parsed.get('inflection_points', [])
            result['overall_trend'] = parsed.get('overall_trend', '')
            result['current_phase'] = parsed.get('current_phase', '')
        except (json.JSONDecodeError, ValueError):
            result['events'] = [
                {'date': it['date'], 'title': it['title'], 'direction': '中性', 'significance': '中', 'summary': ''}
                for it in items[:20]
            ]

    cache_set(tl_cache_key, result, 7200)
    return jsonify(result)


# ── Research Compare (对比) ──────────────────────────────────────────────────

@research_bp.route('/api/cn/research/compare', methods=['POST'])
@safe_route()
def cn_research_compare():
    """Two-step compare for research reports.
    Step 1 (search): { title } → search research DB for related reports
    Step 2 (compare): { title, content, compare_items: [{id, title, date}] } → AI cross-compare
    """
    data = request.get_json(silent=True) or {}
    title = data.get('title', '').strip()
    content = data.get('content', '').strip()
    compare_items = data.get('compare_items', [])
    custom_keywords = data.get('keywords', [])
    exclude_id = data.get('exclude_id', '')

    if not title:
        return jsonify({'error': '缺少title参数'}), 400

    # Step 2: AI comparison
    if compare_items:
        return _do_research_compare(title, content, compare_items)

    # Step 1: Search for related reports
    if custom_keywords and isinstance(custom_keywords, list):
        keywords = [k for k in custom_keywords if isinstance(k, str) and len(k) >= 2][:6]
    else:
        from api.gov_news import _ai_extract_search_keywords
        raw_kw = _ai_extract_search_keywords(title)
        keywords = [k for k in (raw_kw or []) if k not in _GENERIC_KW and len(k) >= 2]
        if not keywords:
            import re
            cleaned_title = re.sub(r'\d{4}\s*年?', '', title)
            for term in _GENERIC_KW:
                cleaned_title = cleaned_title.replace(term, '')
            cleaned_title = cleaned_title.strip()
            if len(cleaned_title) >= 2:
                keywords = [cleaned_title[:8]] if len(cleaned_title) > 8 else [cleaned_title]
            else:
                keywords = [title[:8]]

    related = search_db_research_reports(keywords, exclude_id=exclude_id, limit=60)

    # Group by year
    by_year = {}
    for item in related:
        year = item.get('date', '')[:4] or '未知'
        if year not in by_year:
            by_year[year] = []
        by_year[year].append(item)

    return jsonify({
        'keywords': keywords,
        'related': related,
        'by_year': by_year,
        'total': len(related),
    })


def _do_research_compare(title, content, compare_items):
    """Generate AI comparison between current report and selected related reports."""
    import hashlib
    from services.ai_analysis import call_ai

    # Fetch content for comparison items from DB
    comp_contents = []
    for item in compare_items[:3]:
        comp_id = item.get('id', '')
        comp_title = item.get('title', '')
        comp_date = item.get('date', '')

        comp_text = ''
        if comp_id:
            detail = get_db_report_detail(comp_id)
            if detail:
                comp_text = detail.get('plainText', '')[:4000]

        comp_contents.append({
            'title': comp_title,
            'date': comp_date,
            'content': comp_text,
            'has_content': bool(comp_text),
        })

    # Build comparison prompt
    current_summary = content[:4000] if content else f'（仅有标题：{title}）'
    comp_sections = []
    for i, cc in enumerate(comp_contents):
        if cc['has_content']:
            comp_sections.append(f"【对比研报{i+1}】标题：{cc['title']}\n日期：{cc['date']}\n内容摘要：{cc['content'][:3000]}")
        else:
            comp_sections.append(f"【对比研报{i+1}】标题：{cc['title']}\n日期：{cc['date']}\n（未能获取正文，仅根据标题对比）")

    comp_text = '\n\n'.join(comp_sections)

    # Cache check
    cache_parts = title + '|' + '|'.join(c['title'] for c in comp_contents)
    cache_hash = hashlib.md5(cache_parts.encode()).hexdigest()
    compare_cache_key = f'cn:research:compare:{cache_hash}'
    cached = cache_get(compare_cache_key)
    if cached:
        return jsonify(cached)

    prompt = f"""请对以下研报进行详细的跨期对比分析：

【当前研报】标题：{title}
内容：{current_summary}

{comp_text}

请按以下JSON格式输出详细对比分析结果（不要添加markdown代码块标记）：
{{
  "summary": "整体对比概述，阐述研究观点演变脉络和核心变化（200-300字）",
  "dimensions": [
    {{
      "name": "维度名称（如核心观点、行业判断、盈利预测、估值水平、推荐标的、风险提示等）",
      "current": "当前研报在该维度的具体表述",
      "previous": "对比研报在该维度的具体表述",
      "change": "变化方向（新增/加强/减弱/删除/不变/调整/升级/细化）",
      "analysis": "详细的变化分析（80-150字）"
    }}
  ],
  "newAdditions": ["当前研报新增的重要内容"],
  "removals": ["相比之前不再提及的重要内容"],
  "toneShift": "整体基调变化描述",
  "marketImplication": "对投资策略的具体影响分析（200字以内）",
  "keyTakeaway": "最关键的变化要点总结"
}}

注意：
- dimensions 至少分析 5-8 个维度
- 重点关注研究观点、目标价、评级、风险因素的变化"""

    result_text = call_ai(
        prompt,
        system_prompt='你是一位资深券商研究员，擅长研报的跨期对比分析，能精准捕捉观点变化和投资逻辑调整。请以严格JSON格式输出。',
        max_tokens=6000,
    )

    if not result_text:
        return jsonify({'error': 'AI对比分析失败，请稍后重试'}), 500

    try:
        cleaned = result_text.strip()
        if cleaned.startswith('```'):
            cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
        result = json.loads(cleaned.strip())
    except (json.JSONDecodeError, ValueError):
        result = {'summary': result_text[:1000], 'dimensions': [], 'newAdditions': [], 'removals': [], 'toneShift': '', 'marketImplication': '', 'keyTakeaway': ''}

    result['compare_items'] = [{'title': c['title'], 'date': c['date'], 'has_content': c['has_content']} for c in comp_contents]
    cache_set(compare_cache_key, result, 3600)
    return jsonify(result)
