from flask import Blueprint, jsonify, request
from services.daily_brief import get_or_generate_brief
from services.error_handler import safe_route

brief_bp = Blueprint('brief', __name__)

@brief_bp.route('/api/cn/brief')
@safe_route(cache_key='cn:brief:latest')
def cn_brief():
    force = (request.args.get('force', 'false').lower() == 'true' or
             request.headers.get('X-Force-Refresh', '').lower() == 'true')
    data = get_or_generate_brief(force=force)
    return jsonify(data)
