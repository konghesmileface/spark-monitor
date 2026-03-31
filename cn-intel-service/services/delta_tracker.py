"""Delta tracking engine — "what changed since you last looked?"

Captures snapshots of system state and computes deltas between visits.
Hot storage in Redis (24h), cold storage in MySQL (audit trail).

MySQL table: user_snapshots
"""

import json
import hashlib
import logging
from datetime import datetime, date, timedelta
from contextlib import contextmanager

logger = logging.getLogger('cn-intel.delta-tracker')

_TABLE_CREATED = False

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS user_snapshots (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    snapshot_type   VARCHAR(30) NOT NULL DEFAULT 'full',
    snapshot_data   LONGTEXT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user_type (user_id, snapshot_type),
    KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


@contextmanager
def _get_conn():
    from services.db_pool import get_connection
    conn = get_connection()
    try:
        yield conn
    finally:
        conn.close()


def _ensure_table():
    global _TABLE_CREATED
    if _TABLE_CREATED:
        return
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(_CREATE_TABLE_SQL)
            conn.commit()
        _TABLE_CREATED = True
        logger.warning('[delta] Table user_snapshots ensured')
    except Exception as e:
        logger.warning(f'[delta] Table creation error: {e}')


def capture_snapshot(user_id: str) -> dict:
    """Capture current system state as a snapshot dict."""
    from services import policy_store
    from services.cache import cache_get

    now = datetime.now()
    today = date.today().isoformat()

    # Policy state
    policy_items = policy_store.get_items_by_date_range(
        (date.today() - timedelta(days=3)).isoformat(), today, limit=500)
    policy_count = len(policy_items)
    latest_policy_id = policy_items[0].get('crawled_at', '') if policy_items else ''

    # Get policy scores if available
    high_score_count = 0
    score_cache = cache_get('cn:gov-news:scored')
    if score_cache and isinstance(score_cache, list):
        high_score_count = sum(1 for s in score_cache if s.get('total_score', 0) >= 60)

    # Mood state
    mood_data = cache_get('cn:mood:social') or {}
    dist = mood_data.get('distribution', {})
    mood_hash = hashlib.md5(json.dumps(dist, sort_keys=True).encode()).hexdigest()[:12]
    keywords = mood_data.get('keywords', [])
    kw_top = [k.get('word', '') for k in keywords[:10]]
    kw_hash = hashlib.md5(','.join(kw_top).encode()).hexdigest()[:12]

    snapshot = {
        'ts': now.isoformat(),
        'policy_count': policy_count,
        'policy_latest_crawled': latest_policy_id,
        'policy_high_score_count': high_score_count,
        'mood_distribution': dist,
        'mood_hash': mood_hash,
        'mood_keywords_top10': kw_top,
        'mood_kw_hash': kw_hash,
    }
    return snapshot


def save_snapshot(user_id: str, snapshot: dict):
    """Save snapshot to Redis (hot, 24h) and MySQL (cold, permanent)."""
    from services.cache import cache_set
    _ensure_table()

    # Redis hot storage
    cache_set(f'cn:snapshot:{user_id}', snapshot, 86400)

    # MySQL cold storage
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO user_snapshots (user_id, snapshot_type, snapshot_data) VALUES (%s, %s, %s)",
                    (user_id, 'full', json.dumps(snapshot, ensure_ascii=False, default=str))
                )
            conn.commit()
    except Exception as e:
        logger.warning(f'[delta] Save snapshot error: {e}')


def get_last_snapshot(user_id: str) -> dict | None:
    """Get the most recent snapshot for a user (Redis first, then MySQL)."""
    from services.cache import cache_get
    _ensure_table()

    # Try Redis first
    cached = cache_get(f'cn:snapshot:{user_id}')
    if cached:
        return cached

    # Fallback to MySQL
    try:
        import pymysql
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT snapshot_data, created_at FROM user_snapshots "
                    "WHERE user_id=%s ORDER BY created_at DESC LIMIT 1",
                    (user_id,))
                row = cur.fetchone()
                if row:
                    data = row['snapshot_data']
                    if isinstance(data, str):
                        data = json.loads(data)
                    return data
    except Exception as e:
        logger.warning(f'[delta] Get snapshot error: {e}')
    return None


def compute_delta(user_id: str) -> dict:
    """Compare current state vs last snapshot. Returns structured delta."""
    from services.cache import cache_get, cache_set
    from services import policy_store

    # Check delta cache (10 min)
    cache_key = f'cn:delta:{user_id}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    last = get_last_snapshot(user_id)
    current = capture_snapshot(user_id)
    now = datetime.now()

    if not last:
        # No previous snapshot — everything is "new"
        delta = {
            'has_changes': False,
            'first_visit': True,
            'since': None,
            'hours_away': 0,
            'new_policies': 0,
            'high_score_policies': 0,
            'mood_shifted': False,
            'mood_shift_detail': None,
            'emerging_keywords': [],
            'summary': '欢迎首次使用！设置行业画像获取个性化推送。',
        }
        cache_set(cache_key, delta, 600)
        return delta

    # Calculate time delta
    last_ts = last.get('ts', '')
    try:
        last_time = datetime.fromisoformat(last_ts)
        hours_away = (now - last_time).total_seconds() / 3600
    except Exception:
        hours_away = 0

    # Policy delta
    new_policies = max(0, current['policy_count'] - last.get('policy_count', 0))
    high_score_policies = current.get('policy_high_score_count', 0)

    # Actually fetch new items since last snapshot
    new_items = []
    if last_ts:
        today = date.today().isoformat()
        recent = policy_store.get_items_by_date_range(
            (date.today() - timedelta(days=3)).isoformat(), today, limit=500)
        new_items = [it for it in recent if it.get('crawled_at', '') > last_ts]

    # Mood delta
    current_dist = current.get('mood_distribution', {})
    last_dist = last.get('mood_distribution', {})
    mood_shifted = current.get('mood_hash', '') != last.get('mood_hash', '')

    mood_shift_detail = None
    if mood_shifted and current_dist and last_dist:
        def _pct(d, k):
            t = d.get('positive', 0) + d.get('negative', 0) + d.get('neutral', 0)
            return round(d.get(k, 0) / max(t, 1) * 100, 1)

        neg_now = _pct(current_dist, 'negative')
        neg_before = _pct(last_dist, 'negative')
        pos_now = _pct(current_dist, 'positive')
        pos_before = _pct(last_dist, 'positive')

        shift_pct = abs(neg_now - neg_before) + abs(pos_now - pos_before)
        if shift_pct > 5:
            direction = '转空' if neg_now > neg_before + 5 else ('转多' if pos_now > pos_before + 5 else '波动')
            mood_shift_detail = {
                'direction': direction,
                'negative_pct': neg_now,
                'positive_pct': pos_now,
                'neg_change': round(neg_now - neg_before, 1),
                'pos_change': round(pos_now - pos_before, 1),
            }

    # Keyword delta (emerging = in current but not in last)
    current_kw = set(current.get('mood_keywords_top10', []))
    last_kw = set(last.get('mood_keywords_top10', []))
    emerging = list(current_kw - last_kw)

    # Build summary
    has_changes = new_policies > 0 or mood_shifted or len(emerging) > 0
    parts = []
    if hours_away >= 1:
        parts.append(f'离开{int(hours_away)}小时')
    if new_policies > 0:
        parts.append(f'{len(new_items)}条新政策')
    if high_score_policies > 0:
        parts.append(f'{high_score_policies}条高评分')
    if mood_shift_detail:
        parts.append(f'舆情{mood_shift_detail["direction"]}')
    if emerging:
        parts.append(f'新热词: {", ".join(emerging[:3])}')

    summary = ': '.join(parts) if parts else '暂无显著变化'

    delta = {
        'has_changes': has_changes,
        'first_visit': False,
        'since': last_ts,
        'hours_away': round(hours_away, 1),
        'new_policies': len(new_items),
        'new_policy_items': new_items[:10],  # Top 10 newest
        'high_score_policies': high_score_policies,
        'mood_shifted': mood_shifted,
        'mood_shift_detail': mood_shift_detail,
        'emerging_keywords': emerging,
        'summary': summary,
    }
    cache_set(cache_key, delta, 600)
    return delta


def get_delta_history(user_id: str, days: int = 7) -> list:
    """Get historical snapshots for a user (for trend analysis)."""
    _ensure_table()
    try:
        import pymysql
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    "SELECT snapshot_data, created_at FROM user_snapshots "
                    "WHERE user_id=%s AND created_at >= %s ORDER BY created_at DESC LIMIT 50",
                    (user_id, cutoff))
                results = []
                for row in cur.fetchall():
                    data = row['snapshot_data']
                    if isinstance(data, str):
                        data = json.loads(data)
                    data['_saved_at'] = row['created_at'].isoformat()
                    results.append(data)
                return results
    except Exception as e:
        logger.warning(f'[delta] History error: {e}')
        return []
