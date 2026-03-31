"""PDF research report upload and AI analysis."""

import logging
from datetime import datetime

logger = logging.getLogger('cn-intel.report')


def analyze_pdf(file_path):
    """Extract text from PDF and generate AI analysis."""
    # Extract text from PDF
    full_text = _extract_pdf_text(file_path)
    if not full_text:
        return {'error': '无法提取PDF文本内容', 'success': False}

    # Truncate for AI prompt (keep full text for storage)
    ai_text = full_text[:15000] + '\n... (内容已截断)' if len(full_text) > 15000 else full_text

    # Generate AI analysis
    analysis = _ai_analyze_report(ai_text)

    return {
        'success': True,
        'textLength': len(full_text),
        'plainText': full_text,       # full extracted text for display
        'analysis': analysis,
        'timestamp': datetime.now().isoformat(),
    }


def _extract_pdf_text(file_path):
    """Extract text from PDF using pdfplumber."""
    try:
        import pdfplumber
        text_parts = []
        with pdfplumber.open(file_path) as pdf:
            for i, page in enumerate(pdf.pages[:30]):  # Limit to 30 pages
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
        return '\n\n'.join(text_parts)
    except ImportError:
        logger.warning('pdfplumber not installed, trying basic extraction')
    except Exception as e:
        logger.warning(f'PDF extraction failed: {e}')
    return None


def _ai_analyze_report(text):
    """Use AI to analyze research report text."""
    from services.ai_analysis import call_ai

    prompt = f"""请深度分析以下研报内容，输出JSON格式的结构化分析结果。

研报内容：
{text}

请输出以下JSON格式（注意直接输出JSON，不要加markdown代码块）：
{{
  "title": "研报标题（从正文提取，不要编造）",
  "institution": "发布机构/券商名称",
  "date": "研报发布日期（如有，格式YYYY-MM-DD）",
  "reportType": "研报类型（深度研究/行业点评/公司跟踪/晨会纪要/策略周报/宏观研究/其他）",
  "coreViews": [
    "核心观点1（完整表述，包含关键数据和逻辑链，30-60字）",
    "核心观点2",
    "核心观点3",
    "核心观点4（如有）",
    "核心观点5（如有）"
  ],
  "rating": "投资评级（买入/增持/中性/减持/卖出，若未明确给出则写'未评级'）",
  "targetPrice": "目标价（如有，含币种；无则写空字符串）",
  "keyData": [
    "关键数据点1（如：2025年营收预计xxx亿元，同比+xx%）",
    "关键数据点2（如：毛利率预计提升至xx%）",
    "关键数据点3"
  ],
  "industryChain": "产业链分析（上游原材料→中游制造→下游应用的传导逻辑，100字以内）",
  "competitiveAnalysis": "竞争格局分析（市场份额、竞争壁垒、差异化优势，100字以内）",
  "catalysts": ["股价催化剂1", "催化剂2（如有）"],
  "riskFactors": [
    "风险因素1（具体描述，非泛泛而谈）",
    "风险因素2",
    "风险因素3（如有）"
  ],
  "relatedStocks": ["标的1（代码+名称，如：600519.SH 贵州茅台）", "标的2"],
  "valuation": "估值分析（PE/PB/DCF等估值方法及结论，80字以内）",
  "summary": "研报核心摘要（涵盖研究结论、关键数据、投资建议，300-500字，要求信息密度高、逻辑清晰）",
  "actionSuggestion": "投资操作建议（基于研报结论，给出明确的操作建议，50字以内）"
}}

要求：
1. 核心观点要完整准确，包含具体数据和因果推理，不要只写概括性的一句话
2. summary要信息量充足（300-500字），覆盖研报的研究背景、核心逻辑、关键数据和投资结论
3. 关键数据点提取研报中的具体数字（营收/利润/增速/PE/市占率等）
4. 如果是行业研报，重点分析产业链和竞争格局；如果是公司研报，重点分析盈利驱动和估值
5. 所有字段都要基于研报原文内容，不要编造数据"""

    result = call_ai(
        prompt,
        system_prompt='你是一位拥有15年经验的顶级券商首席分析师。你擅长从研报中提取关键信息并进行深度解读，能准确把握研报的核心逻辑、关键数据和投资结论。你的分析必须基于原文内容，数据引用准确，逻辑链条完整。输出严格JSON格式。',
        max_tokens=3000,
    )

    if result:
        # Try to parse JSON from response
        import json
        try:
            # Handle cases where AI wraps in ```json blocks
            cleaned = result.strip()
            if cleaned.startswith('```'):
                cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
                if cleaned.endswith('```'):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()
            return json.loads(cleaned)
        except (json.JSONDecodeError, ValueError):
            # Return raw text if JSON parsing fails
            return {
                'title': '研报分析',
                'institution': '',
                'coreViews': [result[:300]],
                'rating': '未评级',
                'targetPrice': '',
                'keyData': [],
                'riskFactors': [],
                'relatedStocks': [],
                'summary': result[:500],
            }

    return {
        'title': '分析失败',
        'institution': '',
        'coreViews': ['AI分析服务暂不可用，请稍后重试'],
        'rating': '未评级',
        'targetPrice': '',
        'keyData': [],
        'riskFactors': [],
        'relatedStocks': [],
        'summary': 'AI分析服务暂不可用',
    }
