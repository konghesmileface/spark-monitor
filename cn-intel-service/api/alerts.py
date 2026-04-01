"""Alert API — inbox, mark-read, SSE stream, stats."""

import json
import logging
from flask import Blueprint, jsonify, request, Response
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.alerts-api')

alerts_bp = Blueprint('alerts', __name__)


@alerts_bp.route('/api/cn/alerts')
@safe_route(fallback_data={'alerts': [], 'total': 0})
def get_alerts():
    """Get user alert inbox."""
    from services.alert_engine import get_user_alerts, get_unread_count

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    tier = request.args.get('tier', '')
    unread_only = request.args.get('unread_only', 'false').lower() == 'true'
    limit = min(int(request.args.get('limit', '50')), 200)

    alerts = get_user_alerts(user_id, tier=tier, unread_only=unread_only, limit=limit)
    unread = get_unread_count(user_id)

    return jsonify({
        'alerts': alerts,
        'total': len(alerts),
        'unread': unread,
        'user_id': user_id,
    })


@alerts_bp.route('/api/cn/alerts/mark-read', methods=['POST'])
def mark_alerts_read():
    """Mark alerts as read."""
    from services.alert_engine import mark_read

    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id', '').strip()
    alert_ids = data.get('alert_ids', [])
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400
    if not alert_ids:
        return jsonify({'error': '缺少alert_ids'}), 400

    mark_read(user_id, alert_ids)
    return jsonify({'ok': True, 'marked': len(alert_ids)})


@alerts_bp.route('/api/cn/alerts/stream')
def alert_stream():
    """SSE stream for real-time FLASH alerts."""
    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    # Capture redis reference while app context is active (before generator runs)
    from flask import current_app
    r = current_app.redis

    def event_stream():
        try:
            if not r:
                yield f'data: {json.dumps({"error": "Redis not available"})}\n\n'
                return

            pubsub = r.pubsub()
            pubsub.subscribe(f'cn:alerts:stream:{user_id}')
            # Send initial heartbeat
            yield f'data: {json.dumps({"type": "connected", "user_id": user_id})}\n\n'

            for message in pubsub.listen():
                if message['type'] == 'message':
                    yield f'data: {message["data"]}\n\n'
        except GeneratorExit:
            pass
        except Exception as e:
            logger.warning(f'[alert-sse] Stream error: {e}')

    return Response(
        event_stream(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        }
    )


@alerts_bp.route('/api/cn/alerts/<alert_id>/impact')
@safe_route(fallback_data={'impact': None})
def get_alert_impact(alert_id):
    """Get AI enterprise impact analysis for a specific alert."""
    from services.alert_engine import get_user_alerts

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    # Find the alert
    alerts = get_user_alerts(user_id, limit=200)
    alert = None
    for a in alerts:
        if a.get('id') == alert_id:
            alert = a
            break

    if not alert:
        return jsonify({'error': '告警不存在'}), 404

    impact = alert.get('impact')
    return jsonify({
        'alert_id': alert_id,
        'impact': impact,
        'tier': alert.get('tier'),
        'title': alert.get('title', ''),
    })


@alerts_bp.route('/api/cn/alerts/stats')
@safe_route(fallback_data={'FLASH': 0, 'PRIORITY': 0, 'ROUTINE': 0})
def alert_stats():
    """Get alert statistics for a user."""
    from services.alert_engine import get_alert_stats

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    days = min(int(request.args.get('days', '7')), 30)
    stats = get_alert_stats(user_id, days)
    return jsonify(stats)
