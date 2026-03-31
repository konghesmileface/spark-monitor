"""Sweep API — Delta tracking endpoints for "what changed since you left?" """

import logging
from flask import Blueprint, jsonify, request
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.sweep-api')

sweep_bp = Blueprint('sweep', __name__)


@sweep_bp.route('/api/cn/sweep')
@safe_route(fallback_data={'has_changes': False, 'summary': '服务暂时不可用'})
def get_sweep():
    """Compute delta since user's last visit."""
    from services.delta_tracker import compute_delta

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    delta = compute_delta(user_id)
    return jsonify(delta)


@sweep_bp.route('/api/cn/sweep/acknowledge', methods=['POST'])
def acknowledge_sweep():
    """User has seen the delta — save new snapshot."""
    from services.delta_tracker import capture_snapshot, save_snapshot

    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    snapshot = capture_snapshot(user_id)
    save_snapshot(user_id, snapshot)

    # Invalidate delta cache
    try:
        from flask import current_app
        r = current_app.redis
        if r:
            r.delete(f'cn:delta:{user_id}')
    except Exception:
        pass

    return jsonify({'ok': True, 'snapshot_ts': snapshot.get('ts')})


@sweep_bp.route('/api/cn/sweep/history')
@safe_route(fallback_data={'history': []})
def sweep_history():
    """Historical daily deltas for trend analysis."""
    from services.delta_tracker import get_delta_history

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    days = min(int(request.args.get('days', '7')), 30)
    history = get_delta_history(user_id, days)
    return jsonify({'history': history, 'user_id': user_id, 'days': days})
