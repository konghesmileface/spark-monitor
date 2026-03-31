"""Policy impact chain: traces cause→effect→market_impact for a given policy.
Uses entity overlap to find related policies, then AI generates a causal chain."""

import json
import logging
from datetime import datetime
from services.cache import cache_get, cache_set
from services.cn_entity_registry import find_entities_in_text

logger = logging.getLogger('cn-intel.policy-chain')


def build_impact_chain(policy_title, policy_content=''):
    """Build a causal impact chain for a policy/news article.

    Args:
        policy_title: The policy headline
        policy_content: Optional article text for deeper analysis

    Returns:
        {
            policy: str,
            relatedPolicies: [{title, date, source, overlap_entities}],
            causalChain: [{cause, effect, timeframe, confidence}],
            impactedSectors: [{sector, direction, reasoning}],
            timeline: [{date, event, significance}],
            timestamp
        }
    """
    import hashlib
    cache_key = f'cn:policy-chain:{hashlib.md5(policy_title.encode()).hexdigest()}'
    cached = cache_get(cache_key)
    if cached:
        return cached

    # Step 1: Extract entities from the policy
    analysis_text = policy_title + ' ' + (policy_content or '')
    entities = find_entities_in_text(analysis_text, max_results=10)
    entity_ids = {e['id'] for e in entities}
    entity_names = [e['name'] for e in entities]

    # Step 2: Find related policies via entity overlap in policy_store
    related_policies = []
    try:
        from services import policy_store
        import re
        # Search by extracted entity names
        seen_titles = set()
        for ent in entities[:5]:
            # Use first 2-4 chars of entity name as keyword
            kw = ent['name'][:4] if len(ent['name']) > 4 else ent['name']
            items = policy_store.search_items(kw, limit=10)
            for item in items:
                title = item.get('title', '')
                if title == policy_title or title in seen_titles:
                    continue
                seen_titles.add(title)
                # Check entity overlap
                item_entities = find_entities_in_text(title, max_results=5)
                item_entity_ids = {e['id'] for e in item_entities}
                overlap = entity_ids & item_entity_ids
                if overlap:
                    overlap_names = [e['name'] for e in item_entities if e['id'] in overlap]
                    related_policies.append({
                        'title': title,
                        'date': item.get('date', ''),
                        'source': item.get('source', ''),
                        'overlap_entities': overlap_names,
                    })
        # Sort by number of overlapping entities
        related_policies.sort(key=lambda x: len(x['overlap_entities']), reverse=True)
        related_policies = related_policies[:8]
    except Exception as e:
        logger.warning(f'Policy chain: related policies lookup failed: {e}')

    # Step 3: AI-generate causal chain
    causal_chain = []
    impacted_sectors = []
    timeline = []

    try:
        from services.ai_analysis import call_ai

        related_titles = '\n'.join([f"- {p['title']} ({p['date']}, {p['source']})"
                                     for p in related_policies[:5]])
        entity_str = ', '.join(entity_names[:8])

        prompt = f"""分析以下政策的因果影响链：

政策标题：{policy_title}
{f'政策内容：{policy_content[:3000]}' if policy_content else ''}

涉及实体：{entity_str}

{f'相关历史政策：{chr(10)}{related_titles}' if related_titles else ''}

请以JSON格式输出（不要添加markdown代码块标记）：
{{
  "causalChain": [
    {{"cause": "政策出台的背景/原因", "effect": "直接影响/市场反应", "timeframe": "短期/中期/长期", "confidence": "高/中/低"}}
  ],
  "impactedSectors": [
    {{"sector": "受影响板块", "direction": "利好/利空/中性", "reasoning": "具体逻辑"}}
  ],
  "timeline": [
    {{"date": "预计时间点", "event": "预期事件", "significance": "重要性描述"}}
  ]
}}"""

        result_text = call_ai(
            prompt,
            system_prompt='你是政策影响链分析专家。请分析政策的因果传导路径、受影响板块和时间线。以严格JSON输出。',
            max_tokens=1500,
        )

        if result_text:
            # Parse JSON
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            try:
                parsed = json.loads(cleaned)
                causal_chain = parsed.get('causalChain', [])
                impacted_sectors = parsed.get('impactedSectors', [])
                timeline = parsed.get('timeline', [])
            except (json.JSONDecodeError, ValueError):
                causal_chain = [{'cause': policy_title, 'effect': result_text[:200], 'timeframe': '待分析', 'confidence': '中'}]
    except Exception as e:
        logger.warning(f'Policy chain AI analysis failed: {e}')

    result = {
        'policy': policy_title,
        'entities': [{'id': e['id'], 'name': e['name'], 'type': e['type']} for e in entities],
        'relatedPolicies': related_policies,
        'causalChain': causal_chain,
        'impactedSectors': impacted_sectors,
        'timeline': timeline,
        'timestamp': datetime.now().isoformat(),
    }

    cache_set(cache_key, result, 3600)  # 1h cache
    return result


# ═══════════════════════════════════════════════════════════════════════════════
#  Transmission Chain — 5-level DAG visualization
# ═══════════════════════════════════════════════════════════════════════════════

def build_transmission_chain(title, content=''):
    """Build a 5-level DAG showing policy transmission path.

    Level 0: Policy itself (1 node)
    Level 1: Transmission mechanisms (1-3 nodes)
    Level 2: L1 impacted sectors (2-4 nodes)
    Level 3: L2 impacted sectors (2-4 nodes)
    Level 4: Specific targets/leaders (3-6 nodes)

    Returns:
        {
            nodes: [{id, type, label, direction, level}],
            edges: [{from, to, label, strength}],
            summary: str
        }
    """
    import hashlib
    hash_input = title + (content or "")[:200]
    cache_key = f"cn:policy-transmission:{hashlib.md5(hash_input.encode()).hexdigest()}"
    cached = cache_get(cache_key)
    if cached:
        return cached

    from services.ai_analysis import call_ai

    content_excerpt = content[:3000] if content else ''

    prompt = f"""分析以下政策的市场传导链路，构建5层有向无环图(DAG)。

政策标题：{title}
{f'政策内容：{content_excerpt}' if content_excerpt else ''}

请构建从"政策"到"具体标的"的传导路径，分5层：
- Level 0: 政策本身（1个节点）
- Level 1: 传导机制（1-3个，如"释放流动性""降低融资成本""扩大投资"）
- Level 2: 一级影响板块（2-4个，如"银行""地产""基建"）
- Level 3: 二级细分板块（2-4个，如"股份行""城商行""头部房企"）
- Level 4: 具体标的/龙头方向（3-6个，如"招商银行""保利发展"，可用行业龙头代替具体公司）

每个节点标注方向：利好/利空/中性
每条边标注传导逻辑和强度：strong/medium/weak

以JSON格式输出（不要markdown代码块）：
{{
  "nodes": [
    {{"id": "n0", "type": "policy", "label": "政策简称(10字内)", "direction": "中性", "level": 0}},
    {{"id": "n1", "type": "mechanism", "label": "传导机制", "direction": "利好/利空/中性", "level": 1}},
    {{"id": "n2", "type": "sector_l1", "label": "一级板块", "direction": "利好/利空/中性", "level": 2}},
    {{"id": "n3", "type": "sector_l2", "label": "二级板块", "direction": "利好/利空/中性", "level": 3}},
    {{"id": "n4", "type": "stock", "label": "具体标的", "direction": "利好/利空/中性", "level": 4}}
  ],
  "edges": [
    {{"from": "n0", "to": "n1", "label": "传导逻辑(8字内)", "strength": "strong/medium/weak"}}
  ],
  "summary": "50字传导路径摘要"
}}

要求：
- nodes的id必须唯一，从n0开始编号
- 每个level至少有指定数量的节点
- edges只能从低level指向高level
- 路径要有具体的传导逻辑，不能笼统"""

    try:
        result_text = call_ai(
            prompt,
            system_prompt='你是政策传导链分析专家，擅长构建从政策到市场标的的传导路径。严格按JSON格式输出。',
            max_tokens=2000,
        )
        if result_text:
            cleaned = result_text.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
            if cleaned.endswith('```'):
                cleaned = cleaned[:-3]
            parsed = json.loads(cleaned.strip())
            nodes = parsed.get('nodes', [])
            edges = parsed.get('edges', [])
            summary = parsed.get('summary', '')

            # Post-process: match entity registry for codes
            _enrich_nodes_with_registry(nodes)

            result = {
                'nodes': nodes,
                'edges': edges,
                'summary': summary,
                'timestamp': datetime.now().isoformat(),
            }
            cache_set(cache_key, result, 3600)
            return result
    except Exception as e:
        logger.warning(f'Transmission chain AI failed: {e}')

    # Fallback: simple entity-based chain
    entities = find_entities_in_text(title + ' ' + (content or ''), max_results=8)
    fallback_nodes = [{'id': 'n0', 'type': 'policy', 'label': title[:20], 'direction': '中性', 'level': 0}]
    fallback_edges = []
    for i, ent in enumerate(entities):
        nid = f'n{i + 1}'
        level = 2 if ent['type'] == 'sector' else (4 if ent['type'] == 'stock' else 1)
        fallback_nodes.append({'id': nid, 'type': ent['type'], 'label': ent['name'], 'direction': '中性', 'level': level})
        fallback_edges.append({'from': 'n0', 'to': nid, 'label': '相关', 'strength': 'medium'})

    result = {'nodes': fallback_nodes, 'edges': fallback_edges, 'summary': '基于实体提取的简化传导链', 'timestamp': datetime.now().isoformat()}
    cache_set(cache_key, result, 1800)
    return result


def _enrich_nodes_with_registry(nodes):
    """Try to match node labels against cn_entity_registry for codes."""
    for node in nodes:
        if node.get('type') in ('stock', 'sector_l1', 'sector_l2'):
            matches = find_entities_in_text(node.get('label', ''), max_results=1)
            if matches:
                node['entity_id'] = matches[0]['id']
                if matches[0].get('code'):
                    node['code'] = matches[0]['code']
