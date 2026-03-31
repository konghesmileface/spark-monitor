"""Stock data API endpoints — individual stock quote, history, fund flow.
Uses data_provider (akshare → tushare → eastmoney fallback)."""

from flask import Blueprint, jsonify, request
from services.error_handler import safe_route

stock_bp = Blueprint('stock', __name__)


@stock_bp.route('/api/cn/stock/quote')
@safe_route(cache_key=None)
def stock_quote():
    """GET /api/cn/stock/quote?code=600519 — Individual stock real-time quote."""
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'Missing code parameter'}), 400

    from services.data_provider import get_stock_quote, get_stock_info
    quote = get_stock_quote(code)
    info = get_stock_info(code)

    if not quote and not info:
        return jsonify({'error': f'Stock {code} not found'}), 404

    result = {'code': code}
    if quote:
        result.update(quote)
    if info:
        for k in ('pe', 'pb', 'totalMv', 'circulatingMv', 'industry', 'listingDate'):
            if info.get(k) and not result.get(k):
                result[k] = info[k]

    return jsonify(result)


@stock_bp.route('/api/cn/stock/history')
@safe_route(cache_key=None)
def stock_history():
    """GET /api/cn/stock/history?code=600519&days=30 — Historical K-line."""
    code = request.args.get('code', '').strip()
    days = min(int(request.args.get('days', 30)), 120)
    if not code:
        return jsonify({'error': 'Missing code parameter'}), 400

    from services.data_provider import get_stock_hist
    records = get_stock_hist(code, period='daily', days=days)

    return jsonify({
        'code': code,
        'days': len(records),
        'klines': records,
    })


@stock_bp.route('/api/cn/stock/flow')
@safe_route(cache_key=None)
def stock_flow():
    """GET /api/cn/stock/flow?code=600519 — Individual stock fund flow."""
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'Missing code parameter'}), 400

    from services.data_provider import get_fund_flow
    result = get_fund_flow(code)
    if not result:
        return jsonify({'code': code, 'note': 'No fund flow data available'}), 404

    return jsonify(result)


@stock_bp.route('/api/cn/stock/technical')
@safe_route(cache_key=None)
def stock_technical():
    """GET /api/cn/stock/technical?code=600519&days=60 — RSI/MACD/Bollinger/SMA."""
    code = request.args.get('code', '').strip()
    days = min(int(request.args.get('days', 60)), 120)
    if not code:
        return jsonify({'error': 'Missing code parameter'}), 400

    from services.data_provider import get_technical_indicators
    result = get_technical_indicators(code, days=days)
    return jsonify(result)


@stock_bp.route('/api/cn/stocks/batch')
@safe_route(cache_key=None)
def stock_batch():
    """GET /api/cn/stocks/batch?codes=600519,000858,300750 — Batch stock quotes."""
    codes_str = request.args.get('codes', '').strip()
    if not codes_str:
        return jsonify({'error': 'Missing codes parameter'}), 400

    codes = [c.strip() for c in codes_str.split(',') if c.strip()][:20]

    from services.data_provider import get_stock_batch
    results = get_stock_batch(codes)

    return jsonify({
        'count': len(results),
        'stocks': results,
    })


@stock_bp.route('/api/cn/macro')
@safe_route(cache_key=None)
def macro_indicators():
    """GET /api/cn/macro — CPI/PPI/PMI macro indicators."""
    from services.data_provider import get_macro_indicators
    return jsonify(get_macro_indicators())


@stock_bp.route('/api/cn/sector-rotation')
@safe_route(cache_key=None)
def sector_rotation():
    """GET /api/cn/sector-rotation?top=20 — Sector rotation momentum analysis."""
    top_n = min(int(request.args.get('top', 20)), 30)

    from services.data_provider import get_sector_rotation
    return jsonify(get_sector_rotation(top_n=top_n))
