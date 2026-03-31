"""Agent loop with DeepSeek/Gemini function-calling.
Generalized version: supports custom system_prompt, configurable max_turns,
and Gemini tool-calling as fallback when DeepSeek fails."""

import json
import logging
import requests
from config import Config
from services.tool_registry import get_tool_schemas, execute

logger = logging.getLogger('cn-intel.agent')

_DEFAULT_SYSTEM_PROMPT = """你是World Monitor的AI研究助手。你可以基于研报内容回答用户问题，
并使用工具查询实时市场数据来增强回答。
回答要求：
1. 基于研报内容和实时数据给出专业分析
2. 引用具体数据和来源，用 [来源:xxx] 标注
3. 语言简洁专业，使用中文
4. 如果研报内容不足以回答，主动使用工具查询补充数据"""


def run(question, context='', history=None, max_turns=3,
        system_prompt=None, tool_category=None):
    """Run agent loop with tool-calling.

    Args:
        question: User question
        context: Optional text context (report content, market data, etc.)
        history: Previous chat messages [{role, content}]
        max_turns: Maximum tool-calling rounds (default 3)
        system_prompt: Custom system prompt (uses default if None)
        tool_category: Filter tools by category (None = all tools)

    Returns:
        dict with answer, sources, toolsUsed, timestamp
    """
    from datetime import datetime

    tools_used = []
    tool_schemas = get_tool_schemas(category=tool_category)

    # Build messages
    system_content = system_prompt or _DEFAULT_SYSTEM_PROMPT
    if context:
        system_content += f'\n\n以下是参考上下文：\n{context[:8000]}'

    messages = [{'role': 'system', 'content': system_content}]

    # Add history
    if history:
        for msg in history[-6:]:  # Keep last 6 messages for context
            messages.append({
                'role': msg.get('role', 'user'),
                'content': msg.get('content', ''),
            })

    messages.append({'role': 'user', 'content': question})

    # Try DeepSeek first, then Gemini fallback
    result = _run_deepseek(messages, tool_schemas, tools_used, max_turns)
    if result:
        return result

    # Gemini tool-calling fallback
    result = _run_gemini(messages, tool_schemas, tools_used, max_turns)
    if result:
        return result

    # Final fallback: plain call_ai
    return _fallback_plain(question, context, history, system_prompt)


def _get_proxies():
    """Build proxy dict from config."""
    proxies = {}
    if Config.HTTP_PROXY:
        proxies['http'] = Config.HTTP_PROXY
    if Config.HTTPS_PROXY:
        proxies['https'] = Config.HTTPS_PROXY
    return proxies


def _run_deepseek(messages, tool_schemas, tools_used, max_turns):
    """Run agent loop via DeepSeek function-calling."""
    from datetime import datetime

    api_key = Config.DEEPSEEK_API_KEY
    if not api_key:
        return None

    proxies = _get_proxies()
    msgs = list(messages)  # Copy to avoid mutating original

    for turn in range(max_turns):
        try:
            body = {
                'model': 'deepseek-chat',
                'messages': msgs,
                'max_tokens': 2000,
                'temperature': 0.7,
            }
            if tool_schemas:
                body['tools'] = tool_schemas
                body['tool_choice'] = 'auto'

            resp = requests.post(
                'https://api.deepseek.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                json=body,
                proxies=proxies or None,
                timeout=30,
            )

            if resp.status_code != 200:
                logger.warning(f'Agent DeepSeek returned {resp.status_code}: {resp.text[:200]}')
                return None  # Fall through to Gemini

            data = resp.json()
            choice = data['choices'][0]
            msg = choice['message']

            # Check for tool calls
            tool_calls = msg.get('tool_calls')
            if tool_calls:
                msgs.append(msg)
                for tc in tool_calls:
                    fn_name = tc['function']['name']
                    try:
                        fn_args = json.loads(tc['function'].get('arguments', '{}'))
                    except json.JSONDecodeError:
                        fn_args = {}

                    logger.warning(f'Agent calling tool: {fn_name}({fn_args})')
                    result = execute(fn_name, fn_args)
                    tools_used.append(fn_name)

                    result_str = json.dumps(result, ensure_ascii=False, default=str)
                    if len(result_str) > 3000:
                        result_str = result_str[:3000] + '...(truncated)'

                    msgs.append({
                        'role': 'tool',
                        'tool_call_id': tc['id'],
                        'content': result_str,
                    })
                continue

            # Final answer
            answer = msg.get('content', '')
            if answer:
                return {
                    'answer': answer,
                    'sources': _extract_sources(tools_used),
                    'toolsUsed': list(set(tools_used)),
                    'timestamp': datetime.now().isoformat(),
                }

        except Exception as e:
            logger.warning(f'Agent DeepSeek turn {turn} failed: {e}')
            return None

    return None


def _run_gemini(messages, tool_schemas, tools_used, max_turns):
    """Run agent loop via Gemini function-calling as fallback."""
    from datetime import datetime

    api_key = Config.GEMINI_API_KEY
    if not api_key:
        return None

    proxies = _get_proxies()

    # Convert OpenAI tool schemas to Gemini format
    gemini_tools = _convert_tools_to_gemini(tool_schemas)

    # Convert messages to Gemini format
    system_text = ''
    contents = []
    for msg in messages:
        if msg['role'] == 'system':
            system_text = msg['content']
        elif msg['role'] == 'user':
            contents.append({'role': 'user', 'parts': [{'text': msg['content']}]})
        elif msg['role'] == 'assistant':
            contents.append({'role': 'model', 'parts': [{'text': msg.get('content', '')}]})

    for turn in range(max_turns):
        try:
            body = {
                'contents': contents,
                'generationConfig': {'maxOutputTokens': 2000, 'temperature': 0.7},
            }
            if system_text:
                body['system_instruction'] = {'parts': [{'text': system_text}]}
            if gemini_tools:
                body['tools'] = [{'function_declarations': gemini_tools}]

            url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}'
            resp = requests.post(
                url,
                headers={'Content-Type': 'application/json'},
                json=body,
                proxies=proxies or None,
                timeout=30,
            )

            if resp.status_code != 200:
                logger.warning(f'Agent Gemini returned {resp.status_code}: {resp.text[:200]}')
                return None

            data = resp.json()
            candidates = data.get('candidates', [])
            if not candidates:
                return None

            parts = candidates[0].get('content', {}).get('parts', [])

            # Check for function calls
            fn_calls = [p for p in parts if 'functionCall' in p]
            if fn_calls:
                # Build model response + function results
                contents.append({'role': 'model', 'parts': parts})
                fn_response_parts = []
                for fc in fn_calls:
                    fn_name = fc['functionCall']['name']
                    fn_args = fc['functionCall'].get('args', {})
                    logger.warning(f'Agent Gemini calling tool: {fn_name}({fn_args})')
                    result = execute(fn_name, fn_args)
                    tools_used.append(fn_name)
                    result_str = json.dumps(result, ensure_ascii=False, default=str)
                    if len(result_str) > 3000:
                        result_str = result_str[:3000]
                    fn_response_parts.append({
                        'functionResponse': {
                            'name': fn_name,
                            'response': {'content': result_str},
                        }
                    })
                contents.append({'role': 'user', 'parts': fn_response_parts})
                continue

            # Text response — final answer
            text_parts = [p.get('text', '') for p in parts if 'text' in p]
            answer = '\n'.join(text_parts).strip()
            if answer:
                return {
                    'answer': answer,
                    'sources': _extract_sources(tools_used),
                    'toolsUsed': list(set(tools_used)),
                    'timestamp': datetime.now().isoformat(),
                }

        except Exception as e:
            logger.warning(f'Agent Gemini turn {turn} failed: {e}')
            return None

    return None


def _convert_tools_to_gemini(openai_schemas):
    """Convert OpenAI function-calling schemas to Gemini function_declarations."""
    declarations = []
    for schema in (openai_schemas or []):
        fn = schema.get('function', {})
        params = fn.get('parameters', {})
        # Gemini requires non-empty properties; skip if empty
        props = params.get('properties', {})
        decl = {
            'name': fn['name'],
            'description': fn.get('description', ''),
        }
        if props:
            decl['parameters'] = {
                'type': 'OBJECT',
                'properties': {
                    k: {'type': 'STRING', 'description': v.get('description', '')}
                    for k, v in props.items()
                },
                'required': params.get('required', []),
            }
        declarations.append(decl)
    return declarations


def _fallback_plain(question, context='', history=None, system_prompt=None):
    """Fallback: use plain call_ai without tools."""
    from services.ai_analysis import call_ai
    from datetime import datetime

    prompt = question
    if context:
        prompt = f'参考上下文：\n{context[:8000]}\n\n用户问题：{question}'

    result = call_ai(prompt, system_prompt=system_prompt or '你是一个专业的中国A股市场分析师。')
    return {
        'answer': result or '抱歉，暂时无法回答这个问题。',
        'sources': [],
        'toolsUsed': [],
        'timestamp': datetime.now().isoformat(),
    }


def _extract_sources(tools_used):
    """Map tool names to human-readable source labels."""
    _TOOL_LABELS = {
        'wm_market_overview': '实时大盘数据',
        'wm_sentiment': '市场情绪指数',
        'wm_search_reports': '研报库搜索',
        'wm_hot_events': '今日热点事件',
        'wm_funding_rates': '资金面利率',
        'wm_policy_search': '政策库搜索',
        'wm_stock_detail': '个股行情',
        'wm_mood_keywords': '舆情热词',
        'wm_recent_news': '新闻数据库',
        'wm_entity_sentiment': '实体情绪',
        'wm_policy_chain': '政策影响链',
        'wm_co_occurrence': '关联网络',
    }
    return [_TOOL_LABELS.get(t, t) for t in set(tools_used)]
