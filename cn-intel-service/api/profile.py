"""User profile API — CRUD + personalized feed + AI company research."""

import json
import logging
import threading
from flask import Blueprint, jsonify, request, current_app
from services.cache import cache_get, cache_set
from services.error_handler import safe_route

logger = logging.getLogger('cn-intel.profile-api')

profile_bp = Blueprint('profile', __name__)

# Allowed provider names for custom keys
_VALID_PROVIDERS = {'deepseek', 'gemini', 'claude', 'dashscope'}


def _mask_key(key: str) -> str:
    """Mask an API key: show first 3 and last 4 chars."""
    if not key or len(key) <= 7:
        return '****' if key else ''
    return key[:3] + '****' + key[-4:]


@profile_bp.route('/api/cn/profile', methods=['GET'])
@safe_route(fallback_data={'profile': None})
def get_profile():
    """Get user profile + available industry list."""
    from services.user_profile import get_profile as _get, AVAILABLE_INDUSTRIES
    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'profile': None, 'industries': AVAILABLE_INDUSTRIES})

    # Check cache first
    cache_key = f'cn:profile:{user_id}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify({'profile': cached, 'industries': AVAILABLE_INDUSTRIES})

    profile = _get(user_id)
    if profile:
        cache_set(cache_key, profile, 3600)
    return jsonify({'profile': profile, 'industries': AVAILABLE_INDUSTRIES})


@profile_bp.route('/api/cn/profile', methods=['PUT'])
def upsert_profile():
    """Create or update user profile. Triggers AI company research if company_name is set."""
    from services.user_profile import upsert_profile as _upsert
    from services.cache import cache_set as _cs

    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    company_name = data.get('company_name', '').strip()

    # If company_name is provided, trigger AI research to enrich profile
    if company_name:
        try:
            from services.company_research import research_company, enrich_profile_with_research
            research = research_company(company_name, data.get('industries', []))
            if research:
                data = enrich_profile_with_research(data, research)
                # Attach research summary to response
                data['_research'] = research
                logger.warning(f'[profile] AI enriched profile for {company_name}: '
                               f'{len(data.get("tracked_sectors", []))} sectors, '
                               f'{len(data.get("tracked_keywords", []))} keywords')
        except Exception as e:
            logger.warning(f'[profile] Company research failed (non-blocking): {e}')

    profile = _upsert(user_id, data)
    # If DB failed, profile may be incomplete — merge input data as fallback
    if profile and not profile.get('industries'):
        profile = {
            'user_id': user_id,
            'company_name': data.get('company_name', ''),
            'company_size': data.get('company_size', ''),
            'business_scope': data.get('business_scope', ''),
            'key_products': data.get('key_products', []),
            'industries': data.get('industries', []),
            'tracked_sectors': data.get('tracked_sectors', []),
            'tracked_stocks': data.get('tracked_stocks', []),
            'tracked_keywords': data.get('tracked_keywords', []),
            'exclude_keywords': data.get('exclude_keywords', []),
            'supply_chain_up': data.get('supply_chain_up', []),
            'supply_chain_down': data.get('supply_chain_down', []),
            'competitors': data.get('competitors', []),
            'compliance_concerns': data.get('compliance_concerns', []),
            'business_regions': data.get('business_regions', []),
            'focus_policy_areas': data.get('focus_policy_areas', []),
            'report_frequency': data.get('report_frequency', 'weekly'),
            'ai_provider_order': data.get('ai_provider_order', []),
            'alert_min_score': data.get('alert_min_score', 60),
            'last_seen_at': None,
        }
    # Invalidate caches
    _cs(f'cn:profile:{user_id}', profile, 3600)
    # Clear feed cache
    try:
        r = current_app.redis
        if r:
            for k in r.keys(f'cn:feed:{user_id}:*'):
                r.delete(k)
            r.delete(f'cn:delta:{user_id}')
    except Exception:
        pass

    # Trigger immediate alert scan in background
    _trigger_alert_scan_async(current_app._get_current_object())

    response = {'profile': profile, 'ok': True}
    if data.get('_research'):
        response['research'] = data['_research']
    return jsonify(response)


@profile_bp.route('/api/cn/ai/providers')
@safe_route(fallback_data={'providers': [], 'user_order': []})
def ai_providers():
    """Return available AI providers and user's custom order + key status."""
    from services.ai_analysis import get_available_providers
    from services.user_profile import get_profile as _get

    user_id = request.args.get('user_id', '').strip()
    custom_keys = {}
    user_order = []
    if user_id:
        profile = _get(user_id)
        if profile:
            user_order = profile.get('ai_provider_order', [])
            custom_keys = profile.get('ai_custom_keys', {})

    providers = get_available_providers(custom_keys=custom_keys)
    # Attach per-provider custom key status (never expose platform keys)
    for p in providers:
        ck = custom_keys.get(p['name'], '')
        p['has_custom_key'] = bool(ck)
        p['masked_key'] = _mask_key(ck) if ck else ''
    return jsonify({'providers': providers, 'user_order': user_order})


@profile_bp.route('/api/cn/ai/keys', methods=['PUT'])
def save_ai_keys():
    """Save custom API keys for AI providers (partial update, no full profile upsert)."""
    from services.user_profile import get_profile as _get, upsert_profile as _upsert

    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id', '').strip()
    keys = data.get('keys', {})
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400

    # Validate: only accept known provider names
    cleaned = {}
    for name, key in keys.items():
        if name in _VALID_PROVIDERS and isinstance(key, str):
            cleaned[name] = key.strip()

    # Merge with existing keys (so we don't lose keys not sent in this request)
    profile = _get(user_id)
    existing_keys = (profile.get('ai_custom_keys', {}) if profile else {})
    merged = {**existing_keys, **cleaned}
    # Remove empty keys
    merged = {k: v for k, v in merged.items() if v}

    # Update via upsert (preserves all other profile fields)
    if profile:
        profile['ai_custom_keys'] = merged
        _upsert(user_id, profile)
    else:
        _upsert(user_id, {'ai_custom_keys': merged})

    # Invalidate profile cache
    cache_set(f'cn:profile:{user_id}', None, 0)

    return jsonify({'ok': True, 'keys': {k: _mask_key(v) for k, v in merged.items()}})


@profile_bp.route('/api/cn/ai/key/<provider>', methods=['DELETE'])
def delete_ai_key(provider):
    """Delete a single custom API key for a provider."""
    from services.user_profile import get_profile as _get, upsert_profile as _upsert

    user_id = request.args.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400
    if provider not in _VALID_PROVIDERS:
        return jsonify({'error': f'未知的provider: {provider}'}), 400

    profile = _get(user_id)
    if not profile:
        return jsonify({'ok': True})

    custom_keys = profile.get('ai_custom_keys', {})
    if provider in custom_keys:
        del custom_keys[provider]
        profile['ai_custom_keys'] = custom_keys
        _upsert(user_id, profile)
        cache_set(f'cn:profile:{user_id}', None, 0)

    return jsonify({'ok': True})


@profile_bp.route('/api/cn/profile/heartbeat', methods=['POST'])
def heartbeat():
    """Update last_seen_at timestamp."""
    from services.user_profile import update_last_seen
    data = request.get_json(silent=True) or {}
    user_id = data.get('user_id', '').strip()
    if not user_id:
        return jsonify({'error': '缺少user_id'}), 400
    update_last_seen(user_id)
    return jsonify({'ok': True})


@profile_bp.route('/api/cn/feed')
@safe_route(fallback_data={'items': [], 'total': 0})
def personalized_feed():
    """Get personalized policy+mood feed for a user."""
    from services.user_profile import get_profile as _get
    from services.relevance_scorer import filter_items_for_user, enrich_items_with_relevance
    from services import policy_store

    user_id = request.args.get('user_id', '').strip()
    feed_type = request.args.get('type', 'policy')  # policy|mood|all
    min_rel = float(request.args.get('min_relevance', '0.2'))
    limit = min(int(request.args.get('limit', '100')), 500)

    # Cache
    cache_key = f'cn:feed:{user_id}:{feed_type}' if user_id else f'cn:feed:anon:{feed_type}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    items = []

    if feed_type in ('policy', 'all'):
        # Get recent policy news from MySQL
        from datetime import date, timedelta
        start = (date.today() - timedelta(days=7)).isoformat()
        end = date.today().isoformat()
        policy_items = policy_store.get_items_by_date_range(start, end, limit=500)
        items.extend(policy_items)

    if feed_type in ('mood', 'all'):
        # Get mood data from cache
        mood_cached = cache_get('cn:mood:social')
        if mood_cached:
            platforms = mood_cached.get('platforms', {})
            for plat, posts in platforms.items():
                for p in (posts or [])[:50]:
                    items.append({
                        'title': p.get('content', '')[:200],
                        'source': plat,
                        'date': p.get('time', ''),
                        'category': 'mood',
                        '_type': 'mood',
                    })

    # Apply relevance filtering if user has profile
    profile = _get(user_id) if user_id else None
    if profile:
        items = filter_items_for_user(items, profile, min_relevance=min_rel)
    else:
        items = enrich_items_with_relevance(items, {})

    items = items[:limit]
    result = {'items': items, 'total': len(items), 'user_id': user_id, 'type': feed_type}
    cache_set(cache_key, result, 600)
    return jsonify(result)


def _trigger_alert_scan_async(app):
    """Trigger alert scan in background thread (non-blocking)."""
    def _scan():
        try:
            from services.alert_scanner import run_scan_now
            run_scan_now(app)
        except Exception as e:
            logger.warning(f'[profile] Background alert scan failed: {e}')

    t = threading.Thread(target=_scan, daemon=True)
    t.start()
