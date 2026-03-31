"""Telegram command API — receives bot commands from ais-relay."""

import logging
from flask import Blueprint, jsonify, request

logger = logging.getLogger('cn-intel.telegram-api')

telegram_bp = Blueprint('telegram', __name__)


@telegram_bp.route('/api/cn/telegram/command', methods=['POST'])
def handle_telegram_command():
    """Process a telegram bot command.
    Called by ais-relay.cjs when a /command is received in a monitored channel."""
    from services.telegram_commands import handle_command

    data = request.get_json(silent=True) or {}
    cmd = data.get('command', '').strip().lstrip('/')
    args = data.get('args', '').strip()
    user_id = data.get('user_id', '').strip()

    if not cmd:
        return jsonify({'error': '缺少command字段'}), 400

    response_text = handle_command(cmd, args, user_id)
    return jsonify({
        'response': response_text,
        'command': cmd,
        'ok': True,
    })
