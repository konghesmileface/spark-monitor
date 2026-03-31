"""Cross-domain correlation engine — Policy + Sentiment + Market fusion.

Detects 4 signal patterns:
  CONVERGENCE: policy bullish + sentiment bullish → high confidence
  DIVERGENCE:  policy bullish + sentiment bearish → contrarian signal
  TRIPLE:      all three domains aligned → extreme confidence
  LEADING:     sentiment leads policy (early warning)

Generates actionable trade ideas using structured LLM prompts.
"""

import json
import logging
from datetime import date, datetime, timedelta

logger = logging.getLogger('cn-intel.cross-domain')

# Signal pattern types
CONVERGENCE = 'CONVERGENCE'
DIVERGENCE = 'DIVERGENCE'
TRIPLE = 'TRIPLE'
LEADING = 'LEADING'

# Market regime types
REGIME_RISK_ON = 'risk_on'
REGIME_RISK_OFF = 'risk_off'
REGIME_ROTATION = 'rotation'
REGIME_RANGE_BOUND = 'range_bound'


# Sector name normalization — map different naming conventions to unified keys
_SECTOR_ALIASES = {
    # Policy / Entity names → normalized key
    'AI': '科技', '人工智能': '科技', '半导体': '科技', '芯片': '科技',
    '机器人': '科技', '算力': '科技', '大模型': '科技',
    '新能源车': '新能源', '光伏': '新能源', '锂电': '新能源', '风电': '新能源',
    '充电桩': '新能源', '氢能': '新能源',
    '消费': '消费', '零售': '消费', '白酒': '消费', '食品': '消费',
    '银行': '金融', '券商': '金融', '保险': '金融', '证券': '金融',
    '房地产': '房地产', '地产': '房地产',
    '医药': '医药', '医疗': '医药', '生物': '医药', '创新药': '医药',
    # Sentiment category names → normalized key
    '大盘': '大盘', '股市': '大盘',
    # Market (SW sector) names → normalized key
    '电力设备': '新能源', '通信': '科技', '电子': '科技', '计算机': '科技',
    '食品饮料': '消费', '家用电器': '消费', '商贸零售': '消费', '社会服务': '消费',
    '汽车': '消费', '纺织服饰': '消费', '轻工制造': '消费', '美容护理': '消费',
    '有色金属': '周期', '钢铁': '周期', '煤炭': '周期', '建筑材料': '周期',
    '基础化工': '周期', '建筑装饰': '周期', '石油石化': '周期',
    '农林牧渔': '农业',
    '交通运输': '交运', '公用事业': '公用',
    '国防军工': '军工',
    '传媒': '传媒',
}


def _normalize_sector(name: str) -> str:
    """Normalize sector name to unified key."""
    return _SECTOR_ALIASES.get(name, name)


def _normalize_sector_signals(signals: dict) -> dict:
    """Merge sector signals by normalized name, preferring non-neutral signals."""
    merged = {}
    for name, sig in signals.items():
        key = _normalize_sector(name)
        existing = merged.get(key)
        if existing is None:
            merged[key] = sig.copy()
            merged[key]['_sources'] = [name]
        else:
            existing.setdefault('_sources', []).append(name)
            # Prefer non-neutral over neutral; among same type, prefer higher strength
            new_dir = sig.get('direction', 'neutral')
            old_dir = existing.get('direction', 'neutral')
            prefer_new = False
            if old_dir == 'neutral' and new_dir != 'neutral':
                prefer_new = True
            elif old_dir != 'neutral' and new_dir == 'neutral':
                prefer_new = False
            elif sig.get('strength', 0) > existing.get('strength', 0):
                prefer_new = True
            if prefer_new:
                sources = existing.get('_sources', [])
                merged[key] = sig.copy()
                merged[key]['_sources'] = sources
    return merged


def build_correlation_context(sectors: list = None) -> dict:
    """Aggregate signals from all three domains for specified sectors."""
    from services.cache import cache_get, cache_set

    cache_key = 'cn:insights:correlations'
    if sectors:
        cache_key += ':' + ','.join(sorted(sectors))

    cached = cache_get(cache_key)
    if cached:
        return cached

    policy_signals = _gather_policy_signals(sectors)
    sentiment_signals = _gather_sentiment_signals(sectors)
    market_signals = _gather_market_signals(sectors)

    context = {
        'policy': policy_signals,
        'sentiment': sentiment_signals,
        'market': market_signals,
        'timestamp': datetime.now().isoformat(),
    }

    cache_set(cache_key, context, 600)
    return context


def detect_cross_signals(context: dict) -> list:
    """Detect cross-domain signal patterns from correlation context."""
    policy = context.get('policy', {})
    sentiment = context.get('sentiment', {})
    market = context.get('market', {})

    signals = []

    # Get sector-level signals — normalize names for cross-domain matching
    policy_sectors = _normalize_sector_signals(policy.get('sector_signals', {}))
    sentiment_sectors = _normalize_sector_signals(sentiment.get('sector_signals', {}))
    market_sectors = _normalize_sector_signals(market.get('sector_signals', {}))

    all_sectors = set(list(policy_sectors.keys()) +
                      list(sentiment_sectors.keys()) +
                      list(market_sectors.keys()))

    for sector in all_sectors:
        p_signal = policy_sectors.get(sector, {})
        s_signal = sentiment_sectors.get(sector, {})
        m_signal = market_sectors.get(sector, {})

        p_dir = p_signal.get('direction', 'neutral')  # bullish/bearish/neutral
        s_dir = s_signal.get('direction', 'neutral')
        m_dir = m_signal.get('direction', 'neutral')

        domains_active = sum(1 for d in [p_dir, s_dir, m_dir] if d != 'neutral')

        # TRIPLE: all three aligned
        if p_dir == s_dir == m_dir and p_dir != 'neutral':
            signals.append({
                'pattern': TRIPLE,
                'sector': sector,
                'direction': p_dir,
                'confidence': 0.85,
                'policy_detail': p_signal,
                'sentiment_detail': s_signal,
                'market_detail': m_signal,
                'description': f'{sector}三域共振({p_dir})',
            })
        # CONVERGENCE: any two domains aligned (policy+sentiment, policy+market, or sentiment+market)
        elif p_dir == s_dir and p_dir != 'neutral':
            conf = 0.7 if m_dir == p_dir else (0.65 if m_dir == 'neutral' else 0.5)
            signals.append({
                'pattern': CONVERGENCE,
                'sector': sector,
                'direction': p_dir,
                'confidence': conf,
                'policy_detail': p_signal,
                'sentiment_detail': s_signal,
                'market_detail': m_signal,
                'description': f'{sector}政策+舆情{p_dir}',
            })
        elif p_dir == m_dir and p_dir != 'neutral':
            conf = 0.65 if s_dir == 'neutral' else 0.5
            signals.append({
                'pattern': CONVERGENCE,
                'sector': sector,
                'direction': p_dir,
                'confidence': conf,
                'policy_detail': p_signal,
                'sentiment_detail': s_signal,
                'market_detail': m_signal,
                'description': f'{sector}政策+市场{p_dir}',
            })
        elif s_dir == m_dir and s_dir != 'neutral':
            conf = 0.6 if p_dir == 'neutral' else 0.5
            signals.append({
                'pattern': CONVERGENCE,
                'sector': sector,
                'direction': s_dir,
                'confidence': conf,
                'policy_detail': p_signal,
                'sentiment_detail': s_signal,
                'market_detail': m_signal,
                'description': f'{sector}舆情+市场{s_dir}',
            })
        # DIVERGENCE: any two domains disagree
        elif domains_active >= 2:
            dirs = [(p_dir, '政策'), (s_dir, '舆情'), (m_dir, '市场')]
            active = [(d, label) for d, label in dirs if d != 'neutral']
            if len(active) >= 2 and active[0][0] != active[1][0]:
                signals.append({
                    'pattern': DIVERGENCE,
                    'sector': sector,
                    'direction': 'mixed',
                    'confidence': 0.45,
                    'policy_detail': p_signal,
                    'sentiment_detail': s_signal,
                    'market_detail': m_signal,
                    'description': f'{sector}{active[0][1]}{active[0][0]} vs {active[1][1]}{active[1][0]}(逆向信号)',
                })
        # LEADING: single domain has strong signal
        elif domains_active == 1:
            active_dir = p_dir if p_dir != 'neutral' else (s_dir if s_dir != 'neutral' else m_dir)
            active_sig = p_signal if p_dir != 'neutral' else (s_signal if s_dir != 'neutral' else m_signal)
            active_label = '政策' if p_dir != 'neutral' else ('舆情' if s_dir != 'neutral' else '市场')
            if active_sig.get('strength', 0) > 0.25:
                signals.append({
                    'pattern': LEADING,
                    'sector': sector,
                    'direction': active_dir,
                    'confidence': 0.35,
                    'policy_detail': p_signal,
                    'sentiment_detail': s_signal,
                    'market_detail': m_signal,
                    'description': f'{sector}{active_label}先行信号({active_dir})',
                })

    # Sort by confidence descending
    signals.sort(key=lambda x: x['confidence'], reverse=True)
    return signals


def generate_trade_ideas(user_id: str = None) -> list:
    """Generate AI-powered trade ideas from cross-domain signals."""
    from services.cache import cache_get, cache_set
    from services.ai_analysis import call_ai

    cache_key = f'cn:insights:trade-ideas:{user_id}' if user_id else 'cn:insights:trade-ideas:global'
    cached = cache_get(cache_key)
    if cached:
        return cached

    # Build context
    context = build_correlation_context()
    signals = detect_cross_signals(context)

    if not signals:
        return []

    # Get user profile for personalization
    profile = None
    if user_id:
        from services.user_profile import get_profile
        profile = get_profile(user_id)

    # Build structured prompt
    prompt = _build_fusion_prompt(context, signals, profile)

    # Call AI
    raw = call_ai(prompt, system_prompt=_TRADE_IDEA_SYSTEM, max_tokens=2000)
    if not raw:
        return _fallback_ideas(signals)

    # Parse AI response
    ideas = _parse_trade_ideas(raw)
    if not ideas:
        ideas = _fallback_ideas(signals)

    cache_set(cache_key, ideas, 1800)
    return ideas


def detect_regime() -> dict:
    """Detect current market regime (risk_on/risk_off/rotation/range_bound)."""
    from services.cache import cache_get, cache_set

    cache_key = 'cn:insights:regime'
    cached = cache_get(cache_key)
    if cached:
        return cached

    market = _gather_market_signals()
    indices = market.get('indices', {})

    # Simple regime detection based on index performance + breadth
    sh_change = indices.get('上证指数', {}).get('change_pct', 0) or 0
    cyb_change = indices.get('创业板指', {}).get('change_pct', 0) or 0
    advance_ratio = market.get('advance_ratio', 0.5) or 0.5

    # Check rotation first (large divergence between indices)
    if abs(sh_change - cyb_change) > 2:
        regime = REGIME_ROTATION
        label = '板块轮动'
        desc = '大盘与创业板分化，资金在板块间切换'
    elif sh_change > 1 and advance_ratio > 0.6:
        regime = REGIME_RISK_ON
        label = '风险偏好'
        desc = '市场整体上行，多数个股上涨'
    elif sh_change < -1 and advance_ratio < 0.4:
        regime = REGIME_RISK_OFF
        label = '避险模式'
        desc = '市场整体下行，避险情绪主导'
    else:
        regime = REGIME_RANGE_BOUND
        label = '区间震荡'
        desc = '市场缺乏明确方向，横盘整理'

    result = {
        'regime': regime,
        'label': label,
        'description': desc,
        'sh_change': sh_change,
        'cyb_change': cyb_change,
        'advance_ratio': advance_ratio,
        'timestamp': datetime.now().isoformat(),
    }
    cache_set(cache_key, result, 600)
    return result


# ── Internal helpers ──────────────────────────────────────────────────────────

def _gather_policy_signals(sectors: list = None) -> dict:
    """Gather policy domain signals from recent scored policies."""
    from services.cache import cache_get
    from services import policy_store

    scored = cache_get('cn:gov-news:scored') or []
    today = date.today().isoformat()
    week_ago = (date.today() - timedelta(days=7)).isoformat()

    # Recent policies from DB
    recent = policy_store.get_items_by_date_range(week_ago, today, limit=200)

    # Build sector signals from scored items
    sector_signals = {}
    bullish_kw = [
        '支持', '鼓励', '推动', '加强', '扶持', '利好', '减税', '降息', '降准',
        '补贴', '优惠', '激励', '促进', '发展', '增长', '提升', '加速', '加大',
        '扩大', '深化', '创新', '突破', '利好', '红利', '机遇', '培育', '壮大',
        '升级', '转型', '赋能', '引领', '开放', '放宽', '松绑', '减负',
    ]
    bearish_kw = [
        '限制', '禁止', '整治', '严禁', '收紧', '打压', '加税',
        '处罚', '罚款', '约谈', '警告', '暂停', '叫停', '清理', '整顿',
        '下滑', '萎缩', '风险', '违规', '严查', '取缔', '淘汰', '退出',
    ]

    from services.cn_entity_registry import find_entities_in_text, TYPE_SECTOR
    for item in recent:
        title = item.get('title', '')
        entities = find_entities_in_text(title, max_results=10)
        item_sectors = [e['name'] for e in entities if e.get('type') == TYPE_SECTOR]
        if sectors:
            item_sectors = [s for s in item_sectors if s in sectors]

        is_bull = any(kw in title for kw in bullish_kw)
        is_bear = any(kw in title for kw in bearish_kw)

        for sec in item_sectors:
            if sec not in sector_signals:
                sector_signals[sec] = {'bullish': 0, 'bearish': 0, 'total': 0}
            sector_signals[sec]['total'] += 1
            if is_bull:
                sector_signals[sec]['bullish'] += 1
            if is_bear:
                sector_signals[sec]['bearish'] += 1

    # Compute direction (relaxed threshold: bullish > bearish is enough)
    for sec, sig in sector_signals.items():
        total = sig['total']
        if total == 0:
            sig['direction'] = 'neutral'
            sig['strength'] = 0
        elif sig['bullish'] > sig['bearish']:
            sig['direction'] = 'bullish'
            sig['strength'] = min(sig['bullish'] / max(total, 1), 1.0)
        elif sig['bearish'] > sig['bullish']:
            sig['direction'] = 'bearish'
            sig['strength'] = min(sig['bearish'] / max(total, 1), 1.0)
        else:
            sig['direction'] = 'neutral'
            sig['strength'] = 0.3

    return {
        'total_policies': len(recent),
        'high_score_count': len([s for s in scored if s.get('total_score', 0) >= 60]),
        'sector_signals': sector_signals,
    }


def _gather_sentiment_signals(sectors: list = None) -> dict:
    """Gather sentiment domain signals from mood data."""
    from services.cache import cache_get, cache_set

    mood = cache_get('cn:mood:social') or {}

    # If cache is empty, try fetching fresh data
    if not mood or not mood.get('distribution'):
        try:
            from services.media_crawler import get_social_mood
            mood = get_social_mood() or {}
            if mood and mood.get('distribution'):
                cache_set('cn:mood:social', mood, 600)
        except Exception as e:
            logger.warning(f'_gather_sentiment_signals direct fetch failed: {e}')
    dist = mood.get('distribution', {})

    total = dist.get('positive', 0) + dist.get('negative', 0) + dist.get('neutral', 0)
    pos_pct = dist.get('positive', 0) / max(total, 1) * 100
    neg_pct = dist.get('negative', 0) / max(total, 1) * 100

    overall_dir = 'neutral'
    if pos_pct > 30:
        overall_dir = 'bullish'
    elif neg_pct > 30:
        overall_dir = 'bearish'

    sector_signals = {}

    # Try entity-level sentiment (key may have :all suffix)
    entity_sent = cache_get('cn:mood:entity-sentiment') or cache_get('cn:mood:entity-sentiment:all') or {}
    entities = entity_sent.get('entities', []) if isinstance(entity_sent, dict) else []
    for ent in entities:
        name = ent.get('name', '')
        score = ent.get('sentimentScore', 0)
        if sectors and name not in sectors:
            continue
        direction = 'bullish' if score > 0.2 else ('bearish' if score < -0.2 else 'neutral')
        sector_signals[name] = {
            'direction': direction,
            'strength': abs(score),
            'score': score,
            'positive': ent.get('positive', 0),
            'negative': ent.get('negative', 0),
        }

    # Fallback: derive sector signals from category distribution in mood data
    if not sector_signals:
        categories = mood.get('categories', {})
        # Map mood categories to sector-relevant signals
        _cat_to_sector = {
            '股市': '大盘', '房地产': '房地产', '科技': '科技',
            '消费': '消费', '能源': '新能源', '医疗': '医药',
        }
        for cat_name, cat_data in categories.items():
            sec_name = _cat_to_sector.get(cat_name)
            if not sec_name or (sectors and sec_name not in sectors):
                continue
            if isinstance(cat_data, dict):
                p = cat_data.get('positive', 0)
                n = cat_data.get('negative', 0)
                t = cat_data.get('total', 0)
                if t >= 3:
                    ratio = (p - n) / max(t, 1)
                    direction = 'bullish' if ratio > 0.15 else ('bearish' if ratio < -0.15 else 'neutral')
                    sector_signals[sec_name] = {
                        'direction': direction,
                        'strength': min(abs(ratio), 1.0),
                        'score': round(ratio, 3),
                        'positive': p,
                        'negative': n,
                    }

    return {
        'overall_direction': overall_dir,
        'positive_pct': round(pos_pct, 1),
        'negative_pct': round(neg_pct, 1),
        'total_posts': total,
        'sector_signals': sector_signals,
    }


def _gather_market_signals(sectors: list = None) -> dict:
    """Gather market domain signals from live market data."""
    from services.cache import cache_get, cache_set

    overview = cache_get('cn:market:overview') or {}

    # If cache is empty, try fetching fresh data
    if not overview or not overview.get('indices'):
        try:
            from services.akshare_data import get_market_overview
            overview = get_market_overview() or {}
            if overview and overview.get('indices'):
                cache_set('cn:market:overview', overview, 600)
        except Exception as e:
            logger.warning(f'_gather_market_signals direct fetch failed: {e}')

    # Parse indices — stored as list of {name, price, change, changePercent, ...}
    indices = {}
    for idx in (overview.get('indices') or []):
        name = idx.get('name', '')
        if name in ('上证指数', '深证成指', '创业板指', '科创50'):
            indices[name] = {
                'change_pct': idx.get('changePercent', 0) or 0,
                'price': idx.get('price', 0),
            }

    # Sector data — stored inside overview['sectors'], not separate key
    sector_signals = {}
    sector_data = overview.get('sectors') or []
    for sec in sector_data:
        name = sec.get('name', '')
        if sectors and name not in sectors:
            continue
        change = sec.get('changePercent', 0) or sec.get('change_pct', 0) or 0
        direction = 'bullish' if change > 1 else ('bearish' if change < -1 else 'neutral')
        sector_signals[name] = {
            'direction': direction,
            'strength': min(abs(change) / 5, 1.0),
            'change_pct': change,
        }

    # Advance/decline ratio from limitStats
    limit_stats = overview.get('limitStats', {})
    up = limit_stats.get('up', 0) or 0
    down = limit_stats.get('down', 0) or 0
    advance_ratio = up / max(up + down, 1)

    return {
        'indices': indices,
        'sector_signals': sector_signals,
        'advance_ratio': round(advance_ratio, 3),
    }


_TRADE_IDEA_SYSTEM = """你是专业A股投资策略师。基于政策+舆情+市场三域数据生成交易建议。
要求:
1. 每条建议必须有明确的action(BUY/SELL/WATCH)
2. confidence(0-1): 三域共振>0.8, 两域>0.6, 单域<0.5
3. 建议3-6条, 覆盖不同板块
4. 只输出JSON数组, 不要其他文字
"""


def _build_fusion_prompt(context: dict, signals: list, profile: dict = None) -> str:
    """Build structured prompt for trade idea generation."""
    parts = ['以下是当前A股三域信号数据:\n']

    # Policy
    p = context.get('policy', {})
    parts.append(f'【政策域】近7天{p.get("total_policies",0)}条政策, '
                 f'{p.get("high_score_count",0)}条高评分')
    for sec, sig in list(p.get('sector_signals', {}).items())[:8]:
        parts.append(f'  {sec}: {sig["direction"]} (bull={sig["bullish"]}/bear={sig["bearish"]})')

    # Sentiment
    s = context.get('sentiment', {})
    parts.append(f'\n【舆情域】{s.get("overall_direction","neutral")} '
                 f'(正面{s.get("positive_pct",0):.0f}% 负面{s.get("negative_pct",0):.0f}%)')

    # Market
    m = context.get('market', {})
    for idx, data in m.get('indices', {}).items():
        parts.append(f'  {idx}: {data.get("change_pct",0):+.2f}%')

    # Cross signals
    parts.append('\n【跨域信号】')
    for sig in signals[:6]:
        parts.append(f'  {sig["pattern"]}: {sig["description"]} (conf={sig["confidence"]:.2f})')

    # User context
    if profile:
        parts.append(f'\n【用户关注】行业={profile.get("industries",[])} 个股={profile.get("tracked_stocks",[])}')

    parts.append(
        '\n请生成3-6条交易建议, 返回JSON数组:\n'
        '[{"action":"BUY/SELL/WATCH", "instrument":"板块或个股", "confidence":0.0-1.0, '
        '"timeframe":"短期/中期", "thesis":"100字理由", "signals":["引用的信号"], '
        '"risks":["风险因素"], "entry_condition":"入场条件", "exit_condition":"出场条件"}]'
    )

    return '\n'.join(parts)


def _parse_trade_ideas(raw: str) -> list:
    """Parse AI response into trade idea list."""
    # Find JSON array in response
    try:
        start = raw.index('[')
        end = raw.rindex(']') + 1
        ideas = json.loads(raw[start:end])
        if isinstance(ideas, list):
            # Validate and normalize
            valid = []
            for idea in ideas:
                if isinstance(idea, dict) and 'action' in idea:
                    idea['action'] = idea['action'].upper()
                    idea['confidence'] = max(0, min(1, float(idea.get('confidence', 0.5))))
                    valid.append(idea)
            return valid
    except (ValueError, json.JSONDecodeError):
        pass
    return []


def _fallback_ideas(signals: list) -> list:
    """Generate rule-based ideas when AI is unavailable."""
    ideas = []
    for sig in signals[:4]:
        if sig['pattern'] == TRIPLE and sig['direction'] == 'bullish':
            action = 'BUY'
        elif sig['pattern'] == TRIPLE and sig['direction'] == 'bearish':
            action = 'SELL'
        elif sig['pattern'] == CONVERGENCE and sig['direction'] == 'bullish':
            action = 'BUY'
        elif sig['pattern'] == DIVERGENCE:
            action = 'WATCH'
        else:
            action = 'WATCH'

        ideas.append({
            'action': action,
            'instrument': sig['sector'],
            'confidence': sig['confidence'],
            'timeframe': '短期' if sig['confidence'] > 0.7 else '中期',
            'thesis': sig['description'],
            'signals': [sig['pattern']],
            'risks': ['AI分析不可用, 仅基于规则'],
            'entry_condition': '待AI补充',
            'exit_condition': '待AI补充',
        })
    return ideas
