"""Policy strength scoring system.
Quantifies each policy article on a 0-100 scale across 5 dimensions.
Two modes: fast (rule-based, <1s) and deep (AI-powered, ~3s).

Dimensions (each 0-20):
  1. 发文层级 (Authority Level)   — who issued it
  2. 用词力度 (Language Strength)  — urgency/force of wording
  3. 量化指标 (Quantitative Measures) — numbers, timelines, percentages
  4. 执行机制 (Enforcement Mechanism)— penalties, accountability, reviews
  5. 信号强度 (Signal Strength)    — market significance (AI-only in deep mode)
"""

import json
import logging
import re

logger = logging.getLogger('cn-intel.policy-scoring')


# ── Dimension 1: Authority Level ──────────────────────────────────────────────

_AUTHORITY_KEYWORDS = [
    # Score 20: top-level
    (20, ['中共中央', '国务院', '全国人大', '中央政治局', '总书记', '国家主席',
           '中央经济工作会议', '中央金融工作会议', '政府工作报告', '五年规划']),
    # Score 17: central ministries (important)
    (17, ['中国人民银行', '央行', '财政部', '发改委', '证监会', '金监总局',
           '银保监', '国资委', '商务部']),
    # Score 14: other ministries
    (14, ['工信部', '科技部', '住建部', '交通运输部', '农业农村部', '自然资源部',
           '生态环境部', '教育部', '人社部', '外交部', '外汇局']),
    # Score 11: regulatory/department level
    (11, ['国家统计局', '海关总署', '税务总局', '市场监管总局', '审计署',
           '国家能源局', '国家药监局']),
    # Score 8: local / media commentary
    (8, ['省政府', '省委', '地方政府', '北京市', '上海市', '广东省', '深圳市']),
]


def _score_authority(title: str, content: str) -> tuple:
    text = title + ' ' + content[:500]
    for score, keywords in _AUTHORITY_KEYWORDS:
        for kw in keywords:
            if kw in text:
                return score, kw
    return 5, '一般来源'


# ── Dimension 2: Language Strength ────────────────────────────────────────────

_LANGUAGE_KEYWORDS = [
    # Score 20: mandatory/prohibitive
    (20, ['必须', '严禁', '不得', '一律', '坚决', '强制', '责令', '刻不容缓']),
    # Score 16: strong directive
    (16, ['要求', '落实', '确保', '加大力度', '严格', '全面推进', '着力', '切实']),
    # Score 12: moderate
    (12, ['鼓励', '支持', '推动', '加强', '优化', '完善', '深化', '健全']),
    # Score 8: exploratory
    (8, ['探索', '试点', '研究', '考虑', '逐步', '稳步', '有序']),
    # Score 4: informational
    (4, ['了解', '关注', '参考', '建议', '倡导']),
]


def _score_language(title: str, content: str) -> tuple:
    text = title + ' ' + content[:2000]
    best_score = 0
    best_kw = ''
    for score, keywords in _LANGUAGE_KEYWORDS:
        for kw in keywords:
            if kw in text and score > best_score:
                best_score = score
                best_kw = kw
    return best_score or 4, best_kw or '措辞平和'


# ── Dimension 3: Quantitative Measures ────────────────────────────────────────

_QUANT_PATTERNS = [
    (r'\d+\.?\d*\s*[%％]', '百分比'),
    (r'\d+\.?\d*\s*[万亿]+\s*元', '金额'),
    (r'\d+\.?\d*\s*(?:个)?百分点', '基点'),
    (r'20[2-3]\d年(?:底|末|前|内)', '时间表'),
    (r'(?:第[一二三四]季度|上半年|下半年)', '时间节点'),
    (r'\d+\s*(?:个|条|项|家|只)', '数量'),
    (r'目标[：:].{0,20}\d', '目标值'),
]


def _score_quantitative(title: str, content: str) -> tuple:
    text = title + ' ' + content[:3000]
    found = set()
    for pattern, label in _QUANT_PATTERNS:
        if re.search(pattern, text):
            found.add(label)
    count = len(found)
    if count >= 4:
        return 20, f'含{count}类量化指标({", ".join(list(found)[:3])}等)'
    if count >= 3:
        return 16, f'含{count}类量化指标({", ".join(list(found)[:3])})'
    if count >= 2:
        return 12, f'含{count}类量化指标({", ".join(list(found))})'
    if count == 1:
        return 8, f'含{list(found)[0]}'
    return 3, '无明确量化指标'


# ── Dimension 4: Enforcement Mechanism ────────────────────────────────────────

_ENFORCEMENT_KEYWORDS = [
    (20, ['罚款', '罚则', '追究', '刑事责任', '吊销', '撤销', '取消资格']),
    (16, ['问责', '考核', '督查', '约谈', '通报', '挂牌督办', '整改']),
    (12, ['监督', '检查', '评估', '报告制度', '信息公开', '审计']),
    (8, ['引导', '指导', '培训', '宣传', '示范']),
]


def _score_enforcement(title: str, content: str) -> tuple:
    text = title + ' ' + content[:3000]
    best_score = 0
    best_kw = ''
    for score, keywords in _ENFORCEMENT_KEYWORDS:
        for kw in keywords:
            if kw in text and score > best_score:
                best_score = score
                best_kw = kw
    return best_score or 3, best_kw or '无明确执行机制'


# ── Fast scoring (rule-based) ─────────────────────────────────────────────────

def score_policy_fast(title: str, content: str = '', source: str = '', category: str = '') -> dict:
    """Rule-based fast scoring. Returns score dict in <100ms.
    Signal dimension defaults to 10 (neutral) in fast mode."""
    text = content or title

    auth_score, auth_reason = _score_authority(title, text)
    lang_score, lang_reason = _score_language(title, text)
    quant_score, quant_reason = _score_quantitative(title, text)
    enf_score, enf_reason = _score_enforcement(title, text)
    signal_score = 10  # neutral default for fast mode

    total = auth_score + lang_score + quant_score + enf_score + signal_score
    grade = _total_to_grade(total)

    return {
        'total': total,
        'grade': grade,
        'mode': 'fast',
        'dimensions': [
            {'name': '发文层级', 'score': auth_score, 'max': 20, 'reasoning': auth_reason},
            {'name': '用词力度', 'score': lang_score, 'max': 20, 'reasoning': lang_reason},
            {'name': '量化指标', 'score': quant_score, 'max': 20, 'reasoning': quant_reason},
            {'name': '执行机制', 'score': enf_score, 'max': 20, 'reasoning': enf_reason},
            {'name': '信号强度', 'score': signal_score, 'max': 20, 'reasoning': '快速模式默认中等'},
        ],
    }


# ── Deep scoring (AI-powered) ────────────────────────────────────────────────

def score_policy_deep(title: str, content: str = '', source: str = '', category: str = '') -> dict:
    """AI-powered deep scoring. ~3 seconds. Falls back to fast mode on AI failure."""
    from services.ai_analysis import call_ai

    # Start with rule-based scores as baseline
    fast_result = score_policy_fast(title, content, source, category)

    text_for_ai = content[:4000] if content else title

    prompt = f"""对以下政策/新闻进行力度评分，每个维度0-20分。

标题：{title}
来源：{source}
分类：{category}

内容：{text_for_ai}

请对以下5个维度打分，并给出简短理由（每项20字以内）：
1. 发文层级(0-20): 发文机构的权威级别
2. 用词力度(0-20): 措辞的强制程度和紧迫感
3. 量化指标(0-20): 是否有具体数字/时间表/百分比
4. 执行机制(0-20): 是否有罚则/问责/考核等落地机制
5. 信号强度(0-20): 对金融市场的信号级别和关注度

以JSON格式返回（不要markdown代码块）：
{{"dimensions": [
  {{"name": "发文层级", "score": 数字, "reasoning": "理由"}},
  {{"name": "用词力度", "score": 数字, "reasoning": "理由"}},
  {{"name": "量化指标", "score": 数字, "reasoning": "理由"}},
  {{"name": "执行机制", "score": 数字, "reasoning": "理由"}},
  {{"name": "信号强度", "score": 数字, "reasoning": "理由"}}
]}}"""

    try:
        result_text = call_ai(
            prompt,
            system_prompt='你是政策力度评估专家。严格按JSON格式输出5个维度的评分。每个score必须是0-20的整数。',
            max_tokens=500,
        )
        if result_text:
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            parsed = json.loads(cleaned)
            dims = parsed.get('dimensions', [])
            if len(dims) == 5:
                # Validate and clamp scores
                for d in dims:
                    d['score'] = max(0, min(20, int(d.get('score', 10))))
                    d['max'] = 20
                total = sum(d['score'] for d in dims)
                return {
                    'total': total,
                    'grade': _total_to_grade(total),
                    'mode': 'deep',
                    'dimensions': dims,
                }
    except Exception as e:
        logger.warning(f'Policy deep scoring AI failed: {e}')

    # Fallback: return fast result with mode marker
    fast_result['mode'] = 'fast_fallback'
    return fast_result


# ── Grade helper ──────────────────────────────────────────────────────────────

def _total_to_grade(total: int) -> str:
    if total >= 80:
        return 'S'
    if total >= 60:
        return 'A'
    if total >= 40:
        return 'B'
    if total >= 20:
        return 'C'
    return 'D'
