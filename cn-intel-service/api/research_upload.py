import os
import json
import logging
from flask import Blueprint, request, jsonify, send_from_directory
from config import Config
from services.report_analyzer import analyze_pdf

logger = logging.getLogger('cn-intel.upload')

research_upload_bp = Blueprint('research_upload', __name__)


@research_upload_bp.route('/api/cn/research/upload', methods=['POST'])
def upload_research():
    """Upload a PDF research report for AI analysis. Persists both PDF and analysis."""
    if 'file' not in request.files:
        return jsonify({'error': '请上传PDF文件', 'success': False}), 400

    file = request.files['file']
    if not file.filename:
        return jsonify({'error': '文件名为空', 'success': False}), 400

    if not file.filename.lower().endswith('.pdf'):
        return jsonify({'error': '仅支持PDF格式', 'success': False}), 400

    # Validate PDF magic bytes (%PDF-)
    header = file.read(5)
    file.seek(0)
    if header[:4] != b'%PDF':
        return jsonify({'error': '文件不是有效的PDF', 'success': False}), 400

    # Save file
    upload_dir = Config.UPLOAD_FOLDER
    os.makedirs(upload_dir, exist_ok=True)

    # Use timestamp + original name for uniqueness
    from datetime import datetime
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    safe_name = file.filename.replace('/', '_').replace('\\', '_')
    file_id = f'{ts}_{safe_name}'
    file_path = os.path.join(upload_dir, file_id)
    file.save(file_path)

    logger.warning(f'Research PDF uploaded: {file_path}')

    # Analyze
    result = analyze_pdf(file_path)

    # Persist analysis + extracted text as JSON alongside PDF (do NOT delete the PDF)
    if result.get('success') and result.get('analysis'):
        analysis_path = file_path + '.analysis.json'
        try:
            with open(analysis_path, 'w', encoding='utf-8') as f:
                json.dump({
                    'fileId': file_id,
                    'filename': safe_name,
                    'uploadTime': datetime.now().isoformat(),
                    'analysis': result['analysis'],
                    'plainText': result.get('plainText', ''),
                }, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f'Failed to save analysis JSON: {e}')

    # Add fileId to response
    result['fileId'] = file_id
    return jsonify(result)


@research_upload_bp.route('/api/cn/research/uploads', methods=['GET'])
def list_uploads():
    """List all uploaded research PDFs with their AI analysis."""
    upload_dir = Config.UPLOAD_FOLDER
    uploads = []

    if not os.path.isdir(upload_dir):
        return jsonify({'uploads': [], 'total': 0})

    for fname in sorted(os.listdir(upload_dir), reverse=True):
        if not fname.lower().endswith('.pdf'):
            continue

        analysis_path = os.path.join(upload_dir, fname + '.analysis.json')
        entry = {
            'fileId': fname,
            'filename': fname.split('_', 2)[-1] if '_' in fname else fname,
            'uploadTime': None,
            'analysis': None,
        }

        # Extract upload date from filename prefix (YYYYMMDD_HHMMSS)
        try:
            date_part = fname[:15]  # "20260310_143025"
            from datetime import datetime as dt
            entry['uploadTime'] = dt.strptime(date_part, '%Y%m%d_%H%M%S').isoformat()
        except (ValueError, IndexError):
            pass

        # Load persisted analysis + extracted text
        if os.path.exists(analysis_path):
            try:
                with open(analysis_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    entry['analysis'] = data.get('analysis')
                    entry['plainText'] = data.get('plainText', '')
                    if data.get('uploadTime'):
                        entry['uploadTime'] = data['uploadTime']

                # Backfill plainText for older uploads that don't have it yet
                pdf_path = os.path.join(upload_dir, fname)
                if not entry['plainText'] and os.path.exists(pdf_path):
                    try:
                        from services.report_analyzer import _extract_pdf_text
                        text = _extract_pdf_text(pdf_path)
                        if text:
                            entry['plainText'] = text
                            data['plainText'] = text
                            with open(analysis_path, 'w', encoding='utf-8') as fw:
                                json.dump(data, fw, ensure_ascii=False, indent=2)
                            logger.warning(f'Backfilled plainText for {fname}: {len(text)} chars')
                    except Exception as e:
                        logger.warning(f'Backfill plainText failed for {fname}: {e}')
            except Exception:
                pass

        uploads.append(entry)

    return jsonify({'uploads': uploads, 'total': len(uploads)})


@research_upload_bp.route('/api/cn/research/uploads/<path:file_id>', methods=['GET'])
def serve_upload(file_id):
    """Serve an uploaded PDF file for viewing/download."""
    # Sanitize: only allow PDF files, no path traversal
    if '..' in file_id or '/' in file_id or '\\' in file_id or not file_id.lower().endswith('.pdf'):
        return jsonify({'error': '无效文件ID'}), 400
    upload_dir = os.path.abspath(Config.UPLOAD_FOLDER)
    return send_from_directory(upload_dir, file_id, mimetype='application/pdf')


@research_upload_bp.route('/api/cn/research/uploads/<path:file_id>', methods=['DELETE'])
def delete_upload(file_id):
    """Delete an uploaded research PDF and its analysis."""
    if '..' in file_id or '/' in file_id or '\\' in file_id or not file_id.lower().endswith('.pdf'):
        return jsonify({'error': '无效文件ID'}), 400

    upload_dir = os.path.abspath(Config.UPLOAD_FOLDER)
    pdf_path = os.path.join(upload_dir, file_id)
    analysis_path = pdf_path + '.analysis.json'

    if not os.path.exists(pdf_path):
        return jsonify({'error': '文件不存在'}), 404

    try:
        os.remove(pdf_path)
        if os.path.exists(analysis_path):
            os.remove(analysis_path)
        logger.warning(f'Research PDF deleted: {file_id}')
        return jsonify({'ok': True})
    except Exception as e:
        logger.warning(f'Failed to delete {file_id}: {e}')
        return jsonify({'error': '删除失败'}), 500
