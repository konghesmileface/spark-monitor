"""Report Archive — MySQL-based persistent storage for generated reports.

Stores morning briefs, industry briefs, daily/weekly/monthly reports so they
survive Redis cache expiry and can be viewed/exported historically.
"""

import json
import logging
from datetime import datetime, timedelta

from config import Config

logger = logging.getLogger('cn-intel.report-archive')

_table_created = False


def _get_conn():
    """Get MySQL connection via pool (returns None if MySQL not configured)."""
    if not Config.MYSQL_HOST:
        return None
    try:
        from services.db_pool import get_connection
        return get_connection()
    except Exception as e:
        logger.warning(f'Failed to get DB connection: {e}')
        return None


def _ensure_table():
    """Create report_archives table if it doesn't exist."""
    global _table_created
    if _table_created:
        return
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS report_archives (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(64) NOT NULL,
                    report_type VARCHAR(32) NOT NULL,
                    title VARCHAR(256) DEFAULT '',
                    content LONGTEXT NOT NULL,
                    summary VARCHAR(512) DEFAULT '',
                    risk_score INT DEFAULT NULL,
                    generated_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_user_type (user_id, report_type),
                    INDEX idx_generated (generated_at DESC)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        conn.commit()
        _table_created = True
        logger.warning('report_archives table ensured')
    except Exception as e:
        logger.warning(f'Failed to create report_archives table: {e}')
    finally:
        conn.close()


def archive_report(user_id: str, report_type: str, content: dict,
                   summary: str = '', risk_score: int | None = None,
                   title: str = '') -> int | None:
    """Store a report in MySQL. Returns the report ID, or None on failure."""
    _ensure_table()
    conn = _get_conn()
    if not conn:
        return None
    try:
        generated_at = content.get('generated_at', datetime.now().strftime('%Y-%m-%d %H:%M'))
        # Parse generated_at to datetime
        try:
            gen_dt = datetime.strptime(generated_at, '%Y-%m-%d %H:%M')
        except (ValueError, TypeError):
            gen_dt = datetime.now()

        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO report_archives (user_id, report_type, title, content, summary, risk_score, generated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
            """, (
                user_id, report_type, title[:256],
                json.dumps(content, ensure_ascii=False),
                summary[:512],
                risk_score,
                gen_dt,
            ))
        conn.commit()
        report_id = cur.lastrowid
        logger.warning(f'Archived {report_type} report #{report_id} for user {user_id}')
        return report_id
    except Exception as e:
        logger.warning(f'Failed to archive report: {e}')
        return None
    finally:
        conn.close()


def get_report_history(user_id: str, report_type: str = '',
                       limit: int = 20, offset: int = 0) -> dict:
    """Get paginated report history for a user. Returns {items, total}.

    Special report_type values:
      '_has_risk' — returns reports that have risk_score set (morning_brief, industry_brief, etc.)
    """
    _ensure_table()
    conn = _get_conn()
    if not conn:
        return {'items': [], 'total': 0}
    try:
        with conn.cursor() as cur:
            # Build WHERE clause
            if report_type == '_has_risk':
                where = "WHERE user_id=%s AND risk_score IS NOT NULL"
                params: tuple = (user_id,)
            elif report_type:
                where = "WHERE user_id=%s AND report_type=%s"
                params = (user_id, report_type)
            else:
                where = "WHERE user_id=%s"
                params = (user_id,)

            # Count
            cur.execute(f"SELECT COUNT(*) FROM report_archives {where}", params)
            total = cur.fetchone()[0]

            # Fetch list (without full content for performance)
            cur.execute(f"""
                SELECT id, report_type, title, summary, risk_score, generated_at
                FROM report_archives {where}
                ORDER BY generated_at DESC
                LIMIT %s OFFSET %s
            """, (*params, limit, offset))

            rows = cur.fetchall()
            items = []
            for row in rows:
                items.append({
                    'id': row[0],
                    'report_type': row[1],
                    'title': row[2] or '',
                    'summary': row[3] or '',
                    'risk_score': row[4],
                    'generated_at': row[5].strftime('%Y-%m-%d %H:%M') if row[5] else '',
                })
            return {'items': items, 'total': total}
    except Exception as e:
        logger.warning(f'Failed to get report history: {e}')
        return {'items': [], 'total': 0}
    finally:
        conn.close()


def get_report_detail(report_id: int) -> dict | None:
    """Get full report content by ID."""
    _ensure_table()
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, user_id, report_type, title, content, summary, risk_score, generated_at
                FROM report_archives WHERE id=%s
            """, (report_id,))
            row = cur.fetchone()
            if not row:
                return None
            content = row[4]
            if isinstance(content, str):
                content = json.loads(content)
            return {
                'id': row[0],
                'user_id': row[1],
                'report_type': row[2],
                'title': row[3] or '',
                'content': content,
                'summary': row[5] or '',
                'risk_score': row[6],
                'generated_at': row[7].strftime('%Y-%m-%d %H:%M') if row[7] else '',
            }
    except Exception as e:
        logger.warning(f'Failed to get report detail #{report_id}: {e}')
        return None
    finally:
        conn.close()


def cleanup_old_reports(days: int = 90) -> int:
    """Delete reports older than N days. Returns number of deleted rows."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        cutoff = datetime.now() - timedelta(days=days)
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM report_archives WHERE generated_at < %s",
                (cutoff,)
            )
        conn.commit()
        deleted = cur.rowcount
        if deleted:
            logger.warning(f'Cleaned up {deleted} reports older than {days} days')
        return deleted
    except Exception as e:
        logger.warning(f'Failed to cleanup old reports: {e}')
        return 0
    finally:
        conn.close()


def export_report_html(report: dict) -> str:
    """Generate a downloadable HTML file from a report dict."""
    content = report.get('content', {})
    report_type = report.get('report_type', 'report')
    generated_at = report.get('generated_at', '')
    title = report.get('title', '') or content.get('headline_alert', '') or content.get('headline', '') or '情报报告'

    type_labels = {
        'morning_brief': '每日情报简报',
        'industry_brief': '产业洞察报告',
        'daily': '每日报告',
        'weekly': '周报',
        'monthly': '月报',
    }
    type_label = type_labels.get(report_type, '情报报告')

    # Build HTML sections from content
    sections = []

    if content.get('ceo_one_liner'):
        sections.append(f'<div class="hero">{_h(content["ceo_one_liner"])}</div>')

    if content.get('executive_summary'):
        es = content['executive_summary']
        if isinstance(es, dict):
            parts = []
            if es.get('situation'):
                parts.append(f'<p><strong>形势研判：</strong>{_h(es["situation"])}</p>')
            if es.get('impact'):
                parts.append(f'<p><strong>核心影响：</strong>{_h(es["impact"])}</p>')
            if es.get('direction'):
                parts.append(f'<p><strong>建议方向：</strong>{_h(es["direction"])}</p>')
            sections.append(f'<div class="section"><h3>执行摘要</h3>{"".join(parts)}</div>')
        else:
            sections.append(f'<div class="section"><h3>执行摘要</h3><p>{_h(str(es))}</p></div>')

    if content.get('headline'):
        sections.append(f'<div class="section"><h3>概要</h3><p>{_h(content["headline"])}</p></div>')

    # Opportunities
    opps = content.get('opportunities', [])
    if opps:
        opp_items = ''.join(
            f'<li><strong>{_h(o.get("title",""))}</strong> — {_h(o.get("description",""))}'
            f'{" [" + _h(o.get("estimated_effect","")) + "]" if o.get("estimated_effect") else ""}</li>'
            for o in opps
        )
        sections.append(f'<div class="section"><h3>机遇</h3><ul>{opp_items}</ul></div>')

    # Risks
    risks = content.get('risks', [])
    if risks:
        risk_items = ''.join(
            f'<li><strong>{_h(r.get("title",""))}</strong> — {_h(r.get("description",""))}'
            f'{" [" + _h(r.get("estimated_loss","")) + "]" if r.get("estimated_loss") else ""}</li>'
            for r in risks
        )
        sections.append(f'<div class="section"><h3>风险</h3><ul>{risk_items}</ul></div>')

    # Action items
    actions = content.get('action_items', [])
    if actions:
        action_items = ''.join(
            f'<li>[{_h(a.get("priority",""))}] {_h(a.get("action",""))}'
            f'{" — " + _h(a.get("deadline_hint","")) if a.get("deadline_hint") else ""}</li>'
            for a in actions
        )
        sections.append(f'<div class="section"><h3>行动项</h3><ol>{action_items}</ol></div>')

    # Key developments (industry brief)
    devs = content.get('key_developments', [])
    if devs:
        dev_items = ''.join(
            f'<li><strong>[{_h(d.get("urgency_label",""))}] {_h(d.get("title",""))}</strong>'
            f'<br>{_h(d.get("impact_summary",""))}'
            f'{"<br><em>对贵司影响: " + _h(d.get("business_impact","")) + "</em>" if d.get("business_impact") else ""}'
            f'</li>'
            for d in devs
        )
        sections.append(f'<div class="section"><h3>关键动态</h3><ul>{dev_items}</ul></div>')

    # Outlook
    outlook = content.get('outlook', {})
    if outlook.get('summary'):
        sections.append(f'<div class="section"><h3>展望 ({_h(outlook.get("timeframe","1-4周"))})</h3><p>{_h(outlook["summary"])}</p></div>')

    body = '\n'.join(sections)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{_h(type_label)} — {_h(title)}</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f8f9fa; color: #333; }}
h1 {{ color: #1a1a2e; border-bottom: 2px solid #e8a838; padding-bottom: 8px; }}
h3 {{ color: #e8a838; margin-top: 24px; }}
.meta {{ color: #888; font-size: 14px; margin-bottom: 20px; }}
.hero {{ font-size: 20px; font-weight: 700; color: #1a1a2e; padding: 16px; background: #fff3e0; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #e8a838; }}
.section {{ background: #fff; padding: 16px 20px; border-radius: 8px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }}
ul, ol {{ padding-left: 20px; }}
li {{ margin-bottom: 8px; line-height: 1.6; }}
.footer {{ text-align: center; color: #aaa; font-size: 12px; margin-top: 30px; }}
</style>
</head>
<body>
<h1>{_h(type_label)}</h1>
<div class="meta">生成时间: {_h(generated_at)} | WorldMonitor 企业情报平台</div>
{body}
<div class="footer">WorldMonitor by Spark Finance &copy; 2026</div>
</body>
</html>"""


def _h(text: str) -> str:
    """Simple HTML escape."""
    return (text or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
