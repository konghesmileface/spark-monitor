"""Telegram bot command handler for World Monitor.

Commands:
  /brief [行业]   — AI简报(个性化)
  /sweep           — Delta摘要
  /alerts [tier]   — 未读告警
  /ideas           — 当前交易建议
  /regime          — 市场状态
"""

import logging
from datetime import date, timedelta

logger = logging.getLogger('cn-intel.telegram-commands')


def handle_command(cmd: str, args: str = '', user_id: str = '') -> str:
    """Process a telegram command, return response text."""
    cmd = cmd.strip().lower()
    args = args.strip()

    handlers = {
        'brief': _cmd_brief,
        'sweep': _cmd_sweep,
        'alerts': _cmd_alerts,
        'ideas': _cmd_ideas,
        'regime': _cmd_regime,
        'help': _cmd_help,
    }

    handler = handlers.get(cmd)
    if not handler:
        return f'未知命令: /{cmd}\n使用 /help 查看可用命令'

    try:
        return handler(args, user_id)
    except Exception as e:
        logger.warning(f'[telegram] Command /{cmd} error: {e}')
        return f'命令执行失败: {e}'


def _cmd_brief(args: str, user_id: str) -> str:
    """Generate AI briefing, optionally filtered by industry."""
    from services.cache import cache_get
    from services import policy_store
    from services.ai_analysis import call_ai

    today = date.today().isoformat()
    start = (date.today() - timedelta(days=1)).isoformat()
    policies = policy_store.get_items_by_date_range(start, today, limit=50)

    if args:
        # Filter by industry keyword
        policies = [p for p in policies if args in p.get('title', '')]

    if not policies:
        return f'近24小时无{"" + args + "相关" if args else ""}政策新闻'

    titles = '\n'.join(f'- {p.get("title","")}' for p in policies[:15])
    prompt = (
        f'基于以下最新政策新闻生成简报{"(关注:" + args + ")" if args else ""}:\n'
        f'{titles}\n\n'
        f'生成3-5条要点摘要，每条50字以内，突出市场影响。'
    )
    result = call_ai(prompt, max_tokens=800)
    return result or f'AI简报生成失败\n\n原始新闻({len(policies)}条):\n{titles[:500]}'


def _cmd_sweep(args: str, user_id: str) -> str:
    """Show what changed since last visit."""
    if not user_id:
        return 'Sweep需要用户ID。请先在Web端设置画像。'

    from services.delta_tracker import compute_delta
    delta = compute_delta(user_id)

    if not delta.get('has_changes'):
        return '暂无显著变化' if not delta.get('first_visit') else '欢迎首次使用！请在Web端设置行业画像。'

    parts = [f'📊 Delta摘要 (离开{delta.get("hours_away",0):.0f}小时):']

    if delta.get('new_policies', 0) > 0:
        parts.append(f'📋 {delta["new_policies"]}条新政策')
        for item in delta.get('new_policy_items', [])[:5]:
            parts.append(f'  • {item.get("title","")}')

    if delta.get('high_score_policies', 0) > 0:
        parts.append(f'⚡ {delta["high_score_policies"]}条高评分政策')

    if delta.get('mood_shifted'):
        detail = delta.get('mood_shift_detail', {})
        parts.append(f'📈 舆情{detail.get("direction","变化")} '
                     f'(正面{detail.get("pos_change",0):+.1f}% 负面{detail.get("neg_change",0):+.1f}%)')

    if delta.get('emerging_keywords'):
        parts.append(f'🔑 新热词: {", ".join(delta["emerging_keywords"][:5])}')

    return '\n'.join(parts)


def _cmd_alerts(args: str, user_id: str) -> str:
    """Show unread alerts."""
    if not user_id:
        return '告警功能需要用户ID。'

    from services.alert_engine import get_user_alerts
    tier = args.upper() if args else ''
    alerts = get_user_alerts(user_id, tier=tier, unread_only=True, limit=10)

    if not alerts:
        return f'无未读{"" + tier + "级" if tier else ""}告警'

    parts = [f'🔔 未读告警 ({len(alerts)}条):']
    for a in alerts:
        icon = {'FLASH': '🚨', 'PRIORITY': '⚠️', 'ROUTINE': 'ℹ️'}.get(a.get('tier',''), '📌')
        parts.append(f'{icon} [{a.get("tier","")}] {a.get("title","")} ({a.get("score",0)}分)')

    return '\n'.join(parts)


def _cmd_ideas(args: str, user_id: str) -> str:
    """Show current trade ideas."""
    from services.cross_domain_engine import generate_trade_ideas
    ideas = generate_trade_ideas(user_id=user_id or None)

    if not ideas:
        return '暂无交易建议'

    parts = ['💡 交易建议:']
    for idea in ideas[:5]:
        icon = {'BUY': '🟢', 'SELL': '🔴', 'WATCH': '🟡'}.get(idea.get('action',''), '⚪')
        conf = idea.get('confidence', 0)
        parts.append(
            f'{icon} {idea.get("action","")} {idea.get("instrument","")} '
            f'({conf:.0%}) — {idea.get("thesis","")[:60]}'
        )

    return '\n'.join(parts)


def _cmd_regime(args: str, user_id: str) -> str:
    """Show current market regime."""
    from services.cross_domain_engine import detect_regime
    r = detect_regime()

    icons = {
        'risk_on': '🟢',
        'risk_off': '🔴',
        'rotation': '🟡',
        'range_bound': '⚪',
    }
    icon = icons.get(r.get('regime',''), '⚪')
    return (
        f'{icon} 市场状态: {r.get("label","")}\n'
        f'{r.get("description","")}\n'
        f'上证: {r.get("sh_change",0):+.2f}% | 创业板: {r.get("cyb_change",0):+.2f}%'
    )


def _cmd_help(args: str, user_id: str) -> str:
    """Show available commands."""
    return (
        '📖 World Monitor 命令:\n'
        '/brief [行业] — AI政策简报\n'
        '/sweep — 离开期间变化摘要\n'
        '/alerts [FLASH|PRIORITY] — 未读告警\n'
        '/ideas — 交易建议\n'
        '/regime — 市场状态\n'
        '/help — 本帮助'
    )
