"""Policy event calendar — known upcoming macro events with AI preview.

Static registry of ~30 recurring Chinese macro/policy events,
plus functions to get upcoming events and AI previews.
"""

import json
import logging
from datetime import datetime, date, timedelta

logger = logging.getLogger('cn-intel.policy-calendar')


# ── Event Registry ────────────────────────────────────────────────────────────
# Each event: {name, importance, frequency, typical_month, typical_day,
#              description, impact_sectors, dates_2025, dates_2026}
# dates_YYYY: list of 'YYYY-MM-DD' known/expected dates for that year.

_EVENTS = [
    # ═══ S-Level: Highest importance ═══
    {
        'name': '全国两会',
        'importance': 'S',
        'frequency': '每年3月',
        'description': '全国人大和政协年度会议，确定GDP目标、财政预算、重大改革方向',
        'impact_sectors': ['大盘', '基建', '消费', '新能源'],
        'dates_2025': ['2025-03-05'],
        'dates_2026': ['2026-03-05'],
    },
    {
        'name': '中央经济工作会议',
        'importance': 'S',
        'frequency': '每年12月',
        'description': '定调次年经济政策基调（积极/稳健/宽松）',
        'impact_sectors': ['大盘', '银行', '地产', '消费'],
        'dates_2025': ['2025-12-11'],
        'dates_2026': ['2026-12-10'],
    },
    {
        'name': '中央政治局会议(经济)',
        'importance': 'S',
        'frequency': '4/7/10/12月',
        'description': '季度经济形势分析，可能释放重大政策信号',
        'impact_sectors': ['大盘', '金融', '地产'],
        'dates_2025': ['2025-04-25', '2025-07-24', '2025-10-24', '2025-12-08'],
        'dates_2026': ['2026-04-24', '2026-07-24', '2026-10-23', '2026-12-08'],
    },
    {
        'name': '中央金融工作会议',
        'importance': 'S',
        'frequency': '约5年一次',
        'description': '金融体系顶层设计，上一次2023年10月',
        'impact_sectors': ['银行', '券商', '保险'],
        'dates_2025': [],
        'dates_2026': [],
    },

    # ═══ A-Level: High importance ═══
    {
        'name': '央行货币政策委员会例会',
        'importance': 'A',
        'frequency': '每季度末',
        'description': '货币政策基调措辞变化是关键信号',
        'impact_sectors': ['银行', '债券', '汇率'],
        'dates_2025': ['2025-03-28', '2025-06-27', '2025-09-26', '2025-12-26'],
        'dates_2026': ['2026-03-27', '2026-06-26', '2026-09-25', '2026-12-25'],
    },
    {
        'name': '国务院常务会议',
        'importance': 'A',
        'frequency': '每周三',
        'description': '部署当前重点工作，常有行业利好释放',
        'impact_sectors': ['全行业'],
        'dates_2025': [],  # weekly, not pre-listed
        'dates_2026': [],
    },
    {
        'name': '美联储FOMC利率决议',
        'importance': 'A',
        'frequency': '约每6周',
        'description': '影响全球流动性和中美利差',
        'impact_sectors': ['大盘', '汇率', '黄金', '北向资金'],
        'dates_2025': ['2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
                       '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-17'],
        'dates_2026': ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
                       '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-16'],
    },
    {
        'name': '欧央行利率决议',
        'importance': 'A',
        'frequency': '约每6周',
        'description': '影响欧元区和全球资本流动',
        'impact_sectors': ['汇率', '出口'],
        'dates_2025': ['2025-01-30', '2025-03-06', '2025-04-17', '2025-06-05',
                       '2025-07-24', '2025-09-11', '2025-10-30', '2025-12-18'],
        'dates_2026': ['2026-01-22', '2026-03-05', '2026-04-16', '2026-06-04',
                       '2026-07-16', '2026-09-10', '2026-10-29', '2026-12-17'],
    },

    # ═══ B-Level: Regular data releases ═══
    {
        'name': 'LPR报价',
        'importance': 'B',
        'frequency': '每月20日',
        'description': '贷款市场报价利率，关注是否降息',
        'impact_sectors': ['银行', '地产', '债券'],
        'dates_2025': [f'2025-{m:02d}-20' for m in range(1, 13)],
        'dates_2026': [f'2026-{m:02d}-20' for m in range(1, 13)],
    },
    {
        'name': 'PMI数据',
        'importance': 'B',
        'frequency': '每月1日(官方)/每月初(财新)',
        'description': '制造业采购经理人指数，50荣枯线',
        'impact_sectors': ['制造业', '大盘'],
        'dates_2025': [f'2025-{m:02d}-01' for m in range(1, 13)],
        'dates_2026': [f'2026-{m:02d}-01' for m in range(1, 13)],
    },
    {
        'name': 'CPI/PPI数据',
        'importance': 'B',
        'frequency': '每月中旬',
        'description': '通胀/通缩信号，影响货币政策空间',
        'impact_sectors': ['消费', '原材料', '债券'],
        'dates_2025': ['2025-01-09', '2025-02-17', '2025-03-15', '2025-04-11',
                       '2025-05-12', '2025-06-16', '2025-07-14', '2025-08-09',
                       '2025-09-12', '2025-10-15', '2025-11-09', '2025-12-11'],
        'dates_2026': ['2026-01-09', '2026-02-10', '2026-03-11', '2026-04-11',
                       '2026-05-12', '2026-06-10', '2026-07-09', '2026-08-10',
                       '2026-09-10', '2026-10-15', '2026-11-10', '2026-12-09'],
    },
    {
        'name': '社融/M2数据',
        'importance': 'B',
        'frequency': '每月中旬',
        'description': '社会融资规模和广义货币，反映信贷需求',
        'impact_sectors': ['银行', '大盘', '债券'],
        'dates_2025': ['2025-01-14', '2025-02-14', '2025-03-14', '2025-04-14',
                       '2025-05-14', '2025-06-13', '2025-07-14', '2025-08-14',
                       '2025-09-12', '2025-10-14', '2025-11-14', '2025-12-12'],
        'dates_2026': ['2026-01-14', '2026-02-13', '2026-03-13', '2026-04-14',
                       '2026-05-14', '2026-06-12', '2026-07-14', '2026-08-14',
                       '2026-09-11', '2026-10-14', '2026-11-13', '2026-12-11'],
    },
    {
        'name': '外贸进出口数据',
        'importance': 'B',
        'frequency': '每月中旬',
        'description': '进出口同比增速，反映外需强弱',
        'impact_sectors': ['出口', '航运', '汇率'],
        'dates_2025': ['2025-01-13', '2025-03-07', '2025-04-14', '2025-05-09',
                       '2025-06-10', '2025-07-14', '2025-08-07', '2025-09-10',
                       '2025-10-14', '2025-11-07', '2025-12-10'],
        'dates_2026': ['2026-01-13', '2026-03-07', '2026-04-14', '2026-05-09',
                       '2026-06-09', '2026-07-13', '2026-08-07', '2026-09-09',
                       '2026-10-13', '2026-11-07', '2026-12-09'],
    },
    {
        'name': 'GDP季度数据',
        'importance': 'A',
        'frequency': '每季度中旬',
        'description': '季度国内生产总值增速',
        'impact_sectors': ['大盘', '全行业'],
        'dates_2025': ['2025-01-17', '2025-04-16', '2025-07-15', '2025-10-18'],
        'dates_2026': ['2026-01-19', '2026-04-16', '2026-07-15', '2026-10-19'],
    },
    {
        'name': 'MLF/逆回购操作',
        'importance': 'B',
        'frequency': '每月15日前后',
        'description': '中期借贷便利续做量和利率，流动性风向标',
        'impact_sectors': ['银行', '债券'],
        'dates_2025': [f'2025-{m:02d}-15' for m in range(1, 13)],
        'dates_2026': [f'2026-{m:02d}-15' for m in range(1, 13)],
    },
    {
        'name': '北向资金/外资动向',
        'importance': 'B',
        'frequency': '每日收盘后',
        'description': '沪深港通北向资金净流入，外资风向标',
        'impact_sectors': ['大盘', '白酒', '金融'],
        'dates_2025': [],  # daily
        'dates_2026': [],
    },
    {
        'name': 'A股限售股解禁',
        'importance': 'B',
        'frequency': '每周',
        'description': '大额解禁可能带来抛压',
        'impact_sectors': ['大盘', '个股'],
        'dates_2025': [],
        'dates_2026': [],
    },
    {
        'name': '日本央行利率决议',
        'importance': 'B',
        'frequency': '约每6周',
        'description': '日元走势影响亚太资本流动',
        'impact_sectors': ['汇率'],
        'dates_2025': ['2025-01-24', '2025-03-14', '2025-05-01', '2025-06-13',
                       '2025-07-31', '2025-09-19', '2025-10-31', '2025-12-19'],
        'dates_2026': ['2026-01-22', '2026-03-13', '2026-04-28', '2026-06-12',
                       '2026-07-17', '2026-09-18', '2026-10-30', '2026-12-18'],
    },
]


# ── Public Functions ──────────────────────────────────────────────────────────

def get_upcoming_events(days_ahead: int = 30) -> list:
    """Return events occurring within the next N days, sorted by date."""
    today = date.today()
    end = today + timedelta(days=days_ahead)
    year = today.year

    results = []
    for evt in _EVENTS:
        dates_key = f'dates_{year}'
        dates = evt.get(dates_key, [])
        # Also check next year if we're near year boundary
        if year != end.year:
            dates = dates + evt.get(f'dates_{end.year}', [])

        for d_str in dates:
            try:
                d = date.fromisoformat(d_str)
            except ValueError:
                continue
            if today <= d <= end:
                days_until = (d - today).days
                results.append({
                    'name': evt['name'],
                    'date': d_str,
                    'importance': evt['importance'],
                    'frequency': evt['frequency'],
                    'description': evt['description'],
                    'impact_sectors': evt['impact_sectors'],
                    'days_until': days_until,
                    'is_today': days_until == 0,
                })

        # For weekly/daily events without explicit dates, add a recurring marker
        if not dates and evt['frequency'].startswith('每周'):
            results.append({
                'name': evt['name'],
                'date': '',
                'importance': evt['importance'],
                'frequency': evt['frequency'],
                'description': evt['description'],
                'impact_sectors': evt['impact_sectors'],
                'days_until': -1,
                'is_recurring': True,
            })

    # Sort: today first, then by days_until ascending, recurring at end
    results.sort(key=lambda x: (
        0 if x.get('is_today') else 1,
        x.get('days_until', 999) if x.get('days_until', -1) >= 0 else 999,
    ))
    return results


def get_event_preview(event_name: str) -> dict:
    """AI-generate a preview/expectation for an upcoming event.
    Returns 3 scenarios (bullish/neutral/bearish) with probabilities."""
    from services.cache import cache_get, cache_set
    from services.ai_analysis import call_ai
    import hashlib

    today_str = date.today().isoformat()
    cache_key = f'cn:policy:calendar:preview:{hashlib.md5((event_name + today_str).encode()).hexdigest()}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    # Find event info
    evt_info = next((e for e in _EVENTS if e['name'] == event_name), None)
    desc = evt_info['description'] if evt_info else event_name

    prompt = f"""即将召开/发布：{event_name}
事件说明：{desc}
当前日期：{today_str}

请预判该事件可能的结果，给出三个情景的概率分布和关注要点。
以JSON格式输出（不要markdown代码块）：
{{
  "event": "{event_name}",
  "scenarios": [
    {{"direction": "乐观", "probability": 概率百分比数字, "description": "50字以内描述"}},
    {{"direction": "中性", "probability": 概率百分比数字, "description": "50字以内描述"}},
    {{"direction": "悲观", "probability": 概率百分比数字, "description": "50字以内描述"}}
  ],
  "key_focus": ["关注要点1", "关注要点2", "关注要点3"],
  "market_implication": "对市场的可能影响(80字以内)"
}}"""

    try:
        result_text = call_ai(
            prompt,
            system_prompt='你是宏观经济预测专家。基于当前经济形势，给出合理的事件预判。概率之和应为100%。',
            max_tokens=600,
        )
        if result_text:
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            result = json.loads(cleaned.strip())
            cache_set(cache_key, result, 7200)
            return result
    except Exception as e:
        logger.warning(f'Event preview AI failed: {e}')

    return {'event': event_name, 'scenarios': [], 'key_focus': [], 'market_implication': ''}
