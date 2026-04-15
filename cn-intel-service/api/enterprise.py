"""Enterprise API — weekly/monthly reports + HTML export + dashboard aggregation."""

import logging
from datetime import date, timedelta
from flask import Blueprint, jsonify, request, Response
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.enterprise-api')

enterprise_bp = Blueprint('enterprise', __name__)


@enterprise_bp.route('/api/cn/enterprise/morning-brief')
@safe_route(fallback_data={'status': 'error', 'executive_summary': '情报简报暂时不可用'})
def morning_brief():
    """Generate AI-powered daily intelligence briefing.

    Non-blocking: returns cached brief if available, otherwise triggers
    background generation and returns 'generating' status so the client
    can retry after a few seconds instead of waiting 2-3 minutes.

    Stale cache: returns last-known-good data while regenerating so the
    user sees something useful instead of an empty page.

    Cooldown: if generation fails, sets a 5-minute cooldown to avoid
    repeated futile attempts (e.g. when AI provider balance is depleted).
    """
    import threading
    from services.morning_brief import generate_morning_brief
    from services.cache import cache_get

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'status': 'no_user'}), 400

    # Fast path: return cached brief immediately
    cache_key = f'cn:morning-brief:{user_id}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    from flask import current_app
    app = current_app._get_current_object()
    r = app.redis

    # Check cooldown: if generation recently failed, don't retry for 5 minutes
    cooldown_key = f'cn:morning-brief:cooldown:{user_id}'
    if r and r.get(cooldown_key):
        # Still return stale data if available
        stale = cache_get(f'cn:morning-brief:stale:{user_id}')
        resp = {
            'status': 'unavailable',
            'message': '情报简报生成暂时不可用，请稍后再试',
            'retry_after': 300,
        }
        if stale and stale.get('status') == 'ok':
            resp['stale_brief'] = stale
        return jsonify(resp)

    # No cache — trigger background generation instead of blocking
    lock_key = f'cn:morning-brief:generating:{user_id}'
    stale_key = f'cn:morning-brief:stale:{user_id}'

    # Check if already generating (prevent duplicate threads)
    if r and r.set(lock_key, '1', ex=300, nx=True):
        def _bg_generate():
            try:
                with app.app_context():
                    generate_morning_brief(user_id=user_id)
                    logger.warning(f'[morning-brief] Background generation done for {user_id[:8]}')
            except Exception as e:
                logger.warning(f'[morning-brief] Background generation failed: {e}')
                # Set cooldown: don't retry for 5 minutes after failure
                try:
                    r.set(cooldown_key, '1', ex=300)
                except Exception:
                    pass
            finally:
                try:
                    r.delete(lock_key)
                except Exception:
                    pass

        threading.Thread(target=_bg_generate, daemon=True,
                         name=f'brief-gen-{user_id[:8]}').start()
        logger.warning(f'[morning-brief] Triggered background generation for {user_id[:8]}')

    # Return stale data if available, otherwise just 'generating' status
    stale = cache_get(stale_key)
    resp = {
        'status': 'generating',
        'message': '正在生成今日情报简报，请稍后刷新...',
        'retry_after': 15,
    }
    if stale and stale.get('status') == 'ok':
        resp['stale_brief'] = stale
    return jsonify(resp)


@enterprise_bp.route('/api/cn/enterprise/report/weekly')
@safe_route(fallback_data={'ai_summary': '报告暂时不可用'})
def weekly_report():
    """Generate personalized weekly report."""
    from services.enterprise_reports import generate_weekly_report

    user_id = request.args.get('user_id', '').strip()
    report = generate_weekly_report(user_id=user_id or None)
    return jsonify(report)


@enterprise_bp.route('/api/cn/enterprise/report/monthly')
@safe_route(fallback_data={'ai_summary': '报告暂时不可用'})
def monthly_report():
    """Generate monthly report."""
    from services.enterprise_reports import generate_monthly_report

    user_id = request.args.get('user_id', '').strip()
    report = generate_monthly_report(user_id=user_id or None)
    return jsonify(report)


@enterprise_bp.route('/api/cn/enterprise/report/daily')
@safe_route(fallback_data={'ai_summary': '日报暂时不可用'})
def daily_report():
    """Generate personalized daily report."""
    from services.enterprise_reports import generate_daily_report

    user_id = request.args.get('user_id', '').strip()
    report = generate_daily_report(user_id=user_id or None)
    return jsonify(report)


@enterprise_bp.route('/api/cn/enterprise/report/quarterly')
@safe_route(fallback_data={'ai_summary': '季报暂时不可用'})
def quarterly_report():
    """Generate quarterly strategic report."""
    from services.enterprise_reports import generate_quarterly_report

    user_id = request.args.get('user_id', '').strip()
    report = generate_quarterly_report(user_id=user_id or None)
    return jsonify(report)


@enterprise_bp.route('/api/cn/enterprise/report/annual')
@safe_route(fallback_data={'ai_summary': '年报暂时不可用'})
def annual_report():
    """Generate annual strategic review report."""
    from services.enterprise_reports import generate_annual_report

    user_id = request.args.get('user_id', '').strip()
    report = generate_annual_report(user_id=user_id or None)
    return jsonify(report)


@enterprise_bp.route('/api/cn/enterprise/reports/list')
@safe_route(fallback_data={'reports': []})
def reports_list():
    """Return available report types with latest generation timestamps."""
    from services.enterprise_reports import get_report_list

    user_id = request.args.get('user_id', '').strip()
    reports = get_report_list(user_id=user_id or None)
    return jsonify({'reports': reports})


@enterprise_bp.route('/api/cn/enterprise/export')
def export_report():
    """Export report as downloadable HTML."""
    from services.enterprise_reports import (
        generate_weekly_report, generate_monthly_report,
        generate_daily_report, generate_quarterly_report,
        generate_annual_report, export_to_html,
    )

    report_type = request.args.get('type', 'weekly')
    user_id = request.args.get('user_id', '').strip()

    generators = {
        'daily': generate_daily_report,
        'weekly': generate_weekly_report,
        'monthly': generate_monthly_report,
        'quarterly': generate_quarterly_report,
        'annual': generate_annual_report,
    }
    gen = generators.get(report_type, generate_weekly_report)
    report = gen(user_id=user_id or None)

    html = export_to_html(report)
    filename = f'worldmonitor_{report_type}_{report.get("period","").replace(" ","")}.html'

    return Response(
        html,
        mimetype='text/html',
        headers={
            'Content-Disposition': f'attachment; filename="{filename}"',
        }
    )


# ── Enterprise Dashboard Aggregation ────────────────────────────────────────

@enterprise_bp.route('/api/cn/enterprise/dashboard')
@safe_route(fallback_data={'status': 'error'})
def enterprise_dashboard():
    """One-shot aggregation of all enterprise intelligence data sources."""
    from services.user_profile import get_profile
    from services.delta_tracker import compute_delta
    from services import policy_store
    from services.relevance_scorer import filter_items_for_user
    from services.industry_advisor import generate_industry_brief
    from services.cross_domain_engine import detect_cross_signals, build_correlation_context, detect_regime
    from services.alert_engine import get_alert_stats, get_user_alerts

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'status': 'no_user'}), 400

    # 1. Profile
    profile = get_profile(user_id)
    if not profile or not profile.get('industries'):
        return jsonify({'status': 'no_profile'})

    # 2. Delta tracker
    delta = compute_delta(user_id)

    # 3. Relevant policies (last 3 days)
    end = date.today().isoformat()
    start = (date.today() - timedelta(days=3)).isoformat()
    recent = policy_store.get_items_by_date_range(start, end, limit=200)
    relevant = filter_items_for_user(recent, profile, min_relevance=0.2)[:15]

    # 4. Industry brief (cached via its own Redis layer)
    brief = generate_industry_brief(user_id)

    # 5. Cross-domain signals
    context = build_correlation_context(profile.get('industries'))
    signals = detect_cross_signals(context)[:5]
    regime = detect_regime()

    # 6. Alert stats
    alert_stats = get_alert_stats(user_id, days=3)
    flash_alerts = get_user_alerts(user_id, tier='FLASH', limit=5)

    return jsonify({
        'status': 'ok',
        'profile': {
            'company_name': profile.get('company_name', ''),
            'industries': profile.get('industries', []),
            'tracked_sectors': profile.get('tracked_sectors', []),
        },
        'delta': {
            'summary': delta.get('summary', ''),
            'new_policies': delta.get('new_policies', 0),
            'hours_away': delta.get('hours_away', 0),
            'mood_shifted': delta.get('mood_shifted', False),
            'mood_shift_detail': delta.get('mood_shift_detail'),
            'emerging_keywords': delta.get('emerging_keywords', []),
        },
        'relevant_policies': [{
            'title': p.get('title', ''),
            'source': p.get('source', ''),
            'date': p.get('date', ''),
            'category': p.get('category', ''),
            'url': p.get('url', ''),
            'relevance_score': p.get('_relevance_score', 0),
            'matched_keywords': p.get('_matched_keywords', []),
        } for p in relevant],
        'industry_brief': brief if brief.get('status') != 'no_profile' else None,
        'cross_signals': [{
            'pattern': s['pattern'],
            'sector': s['sector'],
            'direction': s['direction'],
            'confidence': s['confidence'],
            'description': s['description'],
        } for s in signals],
        'regime': regime,
        'alert_stats': alert_stats,
        'flash_alerts': flash_alerts[:5],
    })


# ── Report History (persistent archive) ─────────────────────────────────────

@enterprise_bp.route('/api/cn/reports/history')
@safe_route(fallback_data={'items': [], 'total': 0})
def report_history():
    """Get paginated report history for a user."""
    from services.report_archive import get_report_history

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'items': [], 'total': 0}), 400
    report_type = request.args.get('type', '').strip()
    limit = min(int(request.args.get('limit', 20)), 50)
    offset = int(request.args.get('offset', 0))

    result = get_report_history(user_id, report_type=report_type, limit=limit, offset=offset)
    return jsonify(result)


@enterprise_bp.route('/api/cn/reports/<int:report_id>')
@safe_route(fallback_data={'error': '报告不存在'})
def report_detail(report_id):
    """Get full report content by ID."""
    from services.report_archive import get_report_detail

    report = get_report_detail(report_id)
    if not report:
        return jsonify({'error': '报告不存在'}), 404
    return jsonify({
        'report': report['content'],
        'type': report['report_type'],
        'title': report['title'],
        'generated_at': report['generated_at'],
    })


@enterprise_bp.route('/api/cn/reports/<int:report_id>/export')
def report_export(report_id):
    """Export a historical report as downloadable HTML."""
    from services.report_archive import get_report_detail, export_report_html

    report = get_report_detail(report_id)
    if not report:
        return Response('报告不存在', status=404)

    html = export_report_html(report)
    type_label = report.get('report_type', 'report')
    date_str = (report.get('generated_at', '') or '').replace(' ', '_').replace(':', '')
    filename = f'worldmonitor_{type_label}_{date_str}.html'

    return Response(
        html,
        mimetype='text/html',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


@enterprise_bp.route('/api/cn/enterprise/snapshot', methods=['POST'])
def save_user_snapshot():
    """Save a user state snapshot (called when user leaves the dashboard)."""
    user_id = request.args.get('user_id', '').strip()
    if user_id:
        from services.delta_tracker import capture_snapshot, save_snapshot
        snap = capture_snapshot(user_id)
        save_snapshot(user_id, snap)
    return jsonify({'ok': True})


# ── Report Scheduling ──────────────────────────────────────────────────────

@enterprise_bp.route('/api/cn/enterprise/schedules')
@safe_route(fallback_data={'schedules': []})
def get_schedules():
    """Get user's report generation schedules."""
    from services.report_scheduler import get_user_schedules

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'schedules': []}), 400

    schedules = get_user_schedules(user_id)
    return jsonify({'schedules': schedules})


@enterprise_bp.route('/api/cn/enterprise/schedules', methods=['POST'])
@safe_route(fallback_data={'ok': False})
def save_schedules():
    """Save user's report generation schedules."""
    from services.report_scheduler import save_user_schedules

    data = request.get_json(force=True)
    user_id = data.get('user_id', '').strip()
    schedules = data.get('schedules', [])

    if not user_id:
        return jsonify({'ok': False, 'error': 'missing user_id'}), 400

    save_user_schedules(user_id, schedules)
    return jsonify({'ok': True})
