import json
from flask import Blueprint, jsonify, request, Response, stream_with_context
from services.rag_engine import ask_question

rag_bp = Blueprint('rag', __name__)

@rag_bp.route('/api/cn/rag/ask', methods=['POST'])
def cn_rag_ask():
    body = request.get_json(silent=True) or {}
    question = body.get('question', '').strip()
    if not question:
        return jsonify({'error': '请输入问题'}), 400
    if len(question) > 500:
        return jsonify({'error': '问题过长，请控制在500字以内'}), 400

    session_id = body.get('session_id', '')
    result = ask_question(question, session_id=session_id)
    return jsonify(result)


@rag_bp.route('/api/cn/rag/ask-stream', methods=['POST'])
def cn_rag_ask_stream():
    """SSE streaming endpoint for RAG answers.
    Returns Server-Sent Events: data chunks + final sources."""
    body = request.get_json(silent=True) or {}
    question = body.get('question', '').strip()
    if not question:
        return jsonify({'error': '请输入问题'}), 400
    if len(question) > 500:
        return jsonify({'error': '问题过长，请控制在500字以内'}), 400

    session_id = body.get('session_id', '')

    def generate():
        from services.rag_engine import _classify_question_topics, _get_market_context, \
            _get_sentiment_context, _get_policy_context, _get_report_context, \
            _get_hot_events_context, _get_mood_context, _load_chat_history, \
            _save_chat_history
        from services.ai_analysis import call_ai_stream

        # Build context (same logic as ask_question but simplified)
        topics = _classify_question_topics(question)
        context_parts = []
        all_sources = []

        market_text = _get_market_context()
        if market_text:
            context_parts.append(f'【实时行情】\n{market_text}')

        if topics & {'market', 'sentiment'}:
            sentiment_text = _get_sentiment_context()
            if sentiment_text:
                context_parts.append(f'【市场情绪】\n{sentiment_text}')

        if 'policy' in topics:
            policy_text, policy_sources = _get_policy_context(question)
            if policy_text:
                context_parts.append(f'【相关政策新闻】\n{policy_text}')
                all_sources.extend(policy_sources)

        if 'research' in topics:
            report_text, report_sources = _get_report_context()
            if report_text:
                context_parts.append(f'【近期研报】\n{report_text}')
                all_sources.extend(report_sources)

        if topics & {'hot_events', 'market'}:
            hot_text, hot_sources = _get_hot_events_context()
            if hot_text:
                context_parts.append(f'【今日热点事件】\n{hot_text}')
                all_sources.extend(hot_sources)

        if 'mood' in topics:
            mood_text, mood_sources = _get_mood_context()
            if mood_text:
                context_parts.append(f'【社交舆情】\n{mood_text}')
                all_sources.extend(mood_sources)

        history_text = _load_chat_history(session_id)
        if history_text:
            context_parts.append(f'【对话历史】\n{history_text}')

        context_block = '\n\n'.join(context_parts) if context_parts else '暂无实时数据。'

        system_prompt = f"""你是一个专业的中国A股投资研究助手。

{context_block}

要求：
1. 优先引用上述数据来回答，用 [来源:xxx] 标注
2. 回答专业、客观、有数据支撑
3. 使用中文回答，控制在500字以内"""

        _save_chat_history(session_id, 'user', question)

        # Stream response
        full_answer = []
        for chunk in call_ai_stream(question, system_prompt=system_prompt, max_tokens=2000):
            full_answer.append(chunk)
            yield f"data: {json.dumps({'type': 'chunk', 'content': chunk}, ensure_ascii=False)}\n\n"

        answer_text = ''.join(full_answer)
        _save_chat_history(session_id, 'assistant', answer_text)

        # Send final event with sources
        unique_sources = list(dict.fromkeys(all_sources))[:10]
        yield f"data: {json.dumps({'type': 'done', 'sources': unique_sources}, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        },
    )
