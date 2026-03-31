"""Policy signal tracker: monitors keyword frequency changes over time.
Detects emerging themes and shifting policy emphasis."""

import json
import logging
from datetime import date, timedelta
from services.cache import cache_get, cache_set

logger = logging.getLogger('cn-intel.signal-tracker')

# Tracked keyword groups — each group represents a policy domain
TRACKED_KEYWORDS = {
    '货币政策基调': ['稳健', '适度宽松', '宽松', '偏紧', '精准有力', '灵活适度'],
    '财政政策': ['积极财政', '专项债', '减税降费', '政府投资', '财政赤字'],
    '新兴概念': ['新质生产力', '数字经济', '人工智能', '低空经济', '量子计算'],
    '绿色转型': ['碳中和', '碳达峰', '新能源', '绿色金融', '双碳'],
    '房地产': ['房住不炒', '因城施策', '保交楼', '房地产融资', '城中村'],
    '资本市场': ['注册制', '退市', '分红', '做空', '市值管理', '回购'],
    '科技自主': ['自主可控', '半导体', '芯片', '国产替代', '卡脖子'],
    '消费': ['扩大内需', '促消费', '以旧换新', '消费券', '服务消费'],
    '外贸': ['一带一路', '出口管制', '关税', '外贸稳定', 'RCEP'],
    '金融监管': ['金融安全', '风险防范', '金融监管', '系统性风险', '金融反腐'],
}


def compute_keyword_trends(days_back: int = 90) -> dict:
    """Compute weekly keyword frequency trends over the past N days.

    Returns:
        {
            groups: [{
                name: str,
                keywords: [{
                    word: str,
                    weekly_counts: [{week_start, count}],
                    total: int,
                    trend: 'rising'|'falling'|'stable'|'new',
                    change_pct: float
                }]
            }],
            emerging: [{word, first_seen, count, group}],
            timestamp: str
        }
    """
    cache_key = f'cn:policy:signal-trends:{days_back}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    from services import policy_store

    today = date.today()
    start_date = today - timedelta(days=days_back)

    # Fetch all items in range
    items = policy_store.get_items_by_date_range(
        start_date.isoformat(), today.isoformat(), limit=5000
    )

    if not items:
        result = {'groups': [], 'emerging': [], 'timestamp': today.isoformat()}
        cache_set(cache_key, result, 3600)
        return result

    # Build weekly buckets
    weeks = []
    w_start = start_date
    while w_start <= today:
        w_end = min(w_start + timedelta(days=6), today)
        weeks.append((w_start, w_end))
        w_start = w_end + timedelta(days=1)

    # Count keyword occurrences per week
    groups_result = []
    all_emerging = []

    for group_name, keywords in TRACKED_KEYWORDS.items():
        kw_results = []
        for kw in keywords:
            weekly_counts = []
            total = 0
            for w_start, w_end in weeks:
                count = 0
                for item in items:
                    item_date = item.get('date', '')
                    if not item_date:
                        continue
                    if w_start.isoformat() <= item_date <= w_end.isoformat():
                        if kw in (item.get('title', '') or ''):
                            count += 1
                weekly_counts.append({
                    'week_start': w_start.isoformat(),
                    'count': count,
                })
                total += count

            if total == 0:
                continue

            # Determine trend
            recent = sum(wc['count'] for wc in weekly_counts[-3:]) if len(weekly_counts) >= 3 else total
            earlier = sum(wc['count'] for wc in weekly_counts[:3]) if len(weekly_counts) >= 6 else 0

            if earlier == 0 and recent > 0:
                trend = 'new'
                change_pct = 100.0
            elif earlier > 0:
                change_pct = ((recent - earlier) / earlier) * 100
                if change_pct > 30:
                    trend = 'rising'
                elif change_pct < -30:
                    trend = 'falling'
                else:
                    trend = 'stable'
            else:
                trend = 'stable'
                change_pct = 0

            kw_results.append({
                'word': kw,
                'weekly_counts': weekly_counts,
                'total': total,
                'trend': trend,
                'change_pct': round(change_pct, 1),
            })

            # Track emerging keywords
            if trend in ('new', 'rising') and total >= 3:
                first_seen = next(
                    (wc['week_start'] for wc in weekly_counts if wc['count'] > 0),
                    today.isoformat()
                )
                all_emerging.append({
                    'word': kw,
                    'first_seen': first_seen,
                    'count': total,
                    'group': group_name,
                    'change_pct': round(change_pct, 1),
                })

        if kw_results:
            kw_results.sort(key=lambda x: x['total'], reverse=True)
            groups_result.append({
                'name': group_name,
                'keywords': kw_results,
            })

    # Sort emerging by change_pct
    all_emerging.sort(key=lambda x: x['change_pct'], reverse=True)

    result = {
        'groups': groups_result,
        'emerging': all_emerging[:10],
        'total_items_scanned': len(items),
        'date_range': {
            'start': start_date.isoformat(),
            'end': today.isoformat(),
        },
        'timestamp': today.isoformat(),
    }
    cache_set(cache_key, result, 3600)  # 1h cache
    return result
