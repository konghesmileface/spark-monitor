"""Email service for World Monitor — SMTP-based.

Uses smtplib + email.mime (no Flask-Mail dependency).
Configuration via environment / .env:
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
"""

import logging
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

logger = logging.getLogger('cn-intel.email')

SMTP_HOST = os.getenv('SMTP_HOST', 'smtp.qq.com')
SMTP_PORT = int(os.getenv('SMTP_PORT', '465'))
SMTP_USER = os.getenv('SMTP_USER', '382429046@qq.com')
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD', '')
SMTP_FROM = os.getenv('SMTP_FROM', 'Spark Monitor <panjuekeji@foxmail.com>')



def _send(to_email: str, subject: str, text_body: str, html_body: str) -> bool:
    """Low-level send helper. Returns True on success."""
    if not SMTP_USER or not SMTP_PASSWORD:
        logger.warning('[email] SMTP credentials not configured — cannot send email')
        return False

    msg = MIMEMultipart('alternative')
    msg['Subject'] = subject
    msg['From'] = SMTP_FROM
    msg['To'] = to_email

    msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    try:
        context = ssl.create_default_context()
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=10) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
                server.starttls(context=context)
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        logger.warning(f'[email] Sent "{subject}" to {to_email}')
        return True
    except Exception as e:
        logger.warning(f'[email] Failed to send to {to_email}: {e}')
        return False


# ---------------------------------------------------------------------------
# Branded email wrapper (shared layout for all email types)
# ---------------------------------------------------------------------------

def _wrap_email_body(content_html: str) -> str:
    """Wrap content in the branded Spark Monitor email layout."""
    return f"""\
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e1a;padding:40px 20px;">
<tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid rgba(0,212,255,0.15);border-radius:12px;overflow:hidden;">
<!-- Header bar -->
<tr><td style="background:linear-gradient(135deg,#0d1b3e 0%,#1a1040 100%);padding:28px 36px;border-bottom:1px solid rgba(0,212,255,0.12);">
  <div style="font-size:22px;font-weight:700;color:#e8eef5;letter-spacing:0.5px;">Spark Monitor</div>
  <div style="font-size:12px;color:#00d4ff;margin-top:4px;letter-spacing:1px;">AI-POWERED GLOBAL INTELLIGENCE PLATFORM</div>
</td></tr>
<!-- Content -->
<tr><td style="padding:32px 36px;">
{content_html}
</td></tr>
<!-- Footer -->
<tr><td style="border-top:1px solid rgba(255,255,255,0.06);padding:20px 36px;background:rgba(0,0,0,0.15);">
  <div style="font-size:12px;color:#4b5563;text-align:center;line-height:1.8;">
    上海磐珏信息科技有限公司<br>
    如有疑问请联系：<a href="mailto:hekong@spdt.freeqiye.com" style="color:#00d4ff;text-decoration:none;">hekong@spdt.freeqiye.com</a>
  </div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


# ---------------------------------------------------------------------------
# 1. Password reset verification code
# ---------------------------------------------------------------------------

def send_reset_code(to_email: str, code: str) -> bool:
    """Send a 6-digit verification code to *to_email*. Returns True on success."""
    content = f"""\
  <div style="font-size:15px;color:#c9d1dc;line-height:1.8;">
    您好，<br><br>
    您正在重置 Spark Monitor 账户密码。请使用以下验证码完成操作：
  </div>
  <div style="text-align:center;padding:20px 0 24px;">
    <div style="display:inline-block;background:rgba(0,212,255,0.08);border:2px solid rgba(0,212,255,0.3);border-radius:12px;padding:16px 40px;font-size:32px;font-weight:800;letter-spacing:8px;color:#00d4ff;">{code}</div>
  </div>
  <div style="font-size:13px;color:#8b96b1;line-height:1.7;">
    此验证码 <strong style="color:#e8eef5;">15 分钟</strong>内有效。如非本人操作，请忽略此邮件。
  </div>"""

    text_body = f'您的 Spark Monitor 密码重置验证码是: {code}\n此验证码 15 分钟内有效。如非本人操作，请忽略此邮件。'
    return _send(to_email, f'【Spark Monitor】密码重置验证码: {code}', text_body, _wrap_email_body(content))


# ---------------------------------------------------------------------------
# 2. Account approved notification (user self-registered, admin approved)
# ---------------------------------------------------------------------------

def send_account_approved(to_email: str, contact_name: str = '', company_name: str = '',
                          login_url: str = '') -> bool:
    """Notify user that their application has been approved."""
    name_display = contact_name or to_email.split('@')[0]
    company_display = f'（{company_name}）' if company_name else ''

    content = f"""\
  <div style="font-size:15px;color:#c9d1dc;line-height:1.8;margin-bottom:20px;">
    尊敬的 <strong style="color:#e8eef5;">{name_display}</strong>{company_display}，您好！
  </div>

  <div style="background:linear-gradient(135deg,rgba(16,185,129,0.12) 0%,rgba(0,212,255,0.08) 100%);border:1px solid rgba(16,185,129,0.25);border-radius:10px;padding:20px 24px;margin-bottom:24px;">
    <div style="font-size:16px;font-weight:700;color:#10b981;margin-bottom:8px;">&#10003; 账户审核已通过</div>
    <div style="font-size:14px;color:#c9d1dc;line-height:1.7;">
      您的 Spark Monitor 平台申请已审核通过，账户现已激活。您可以使用注册时填写的邮箱和密码登录平台。
    </div>
  </div>

  <div style="margin-bottom:24px;">
    <div style="font-size:13px;color:#8b96b1;margin-bottom:8px;">您的登录信息</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;">
      <tr>
        <td style="padding:10px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px 8px 0 0;">
          <span style="font-size:12px;color:#8b96b1;">登录邮箱</span><br>
          <span style="font-size:15px;color:#e8eef5;font-weight:600;">{to_email}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-top:none;border-radius:0 0 8px 8px;">
          <span style="font-size:12px;color:#8b96b1;">登录密码</span><br>
          <span style="font-size:14px;color:#c9d1dc;">您注册时设置的密码</span>
        </td>
      </tr>
    </table>
  </div>

  <div style="text-align:center;padding:4px 0 20px;">
    <a href="{login_url or '#'}" style="display:inline-block;background:linear-gradient(135deg,#0066ff 0%,#00d4ff 100%);color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 40px;border-radius:8px;letter-spacing:0.5px;">登录 Spark Monitor</a>
  </div>

  <div style="font-size:13px;color:#8b96b1;line-height:1.7;">
    平台功能包括：全球情报监控、AI 政策分析、企业定制报告、产业洞察等。如有任何使用疑问，请随时联系我们。
  </div>"""

    text_body = (
        f'{name_display}，您好！\n\n'
        f'您的 Spark Monitor 平台申请已审核通过，账户现已激活。\n'
        f'登录邮箱：{to_email}\n'
        f'密码：您注册时设置的密码\n\n'
        f'如有疑问请联系：hekong@spdt.freeqiye.com'
    )
    return _send(to_email, '【Spark Monitor】账户审核通过 — 欢迎使用', text_body, _wrap_email_body(content))


# ---------------------------------------------------------------------------
# 3. Account created by admin (with credentials)
# ---------------------------------------------------------------------------

def send_account_created(to_email: str, password: str, contact_name: str = '',
                         company_name: str = '', expires_at: str = '',
                         login_url: str = '') -> bool:
    """Notify user that an account has been created for them by admin, with credentials."""
    name_display = contact_name or to_email.split('@')[0]
    company_display = f'（{company_name}）' if company_name else ''

    expires_html = ''
    expires_text = ''
    if expires_at:
        expires_html = f"""\
      <tr>
        <td style="padding:10px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-top:none;border-radius:0 0 8px 8px;">
          <span style="font-size:12px;color:#8b96b1;">服务有效期至</span><br>
          <span style="font-size:14px;color:#c9d1dc;">{expires_at}</span>
        </td>
      </tr>"""
        expires_text = f'服务有效期至：{expires_at}\n'
        pw_radius_bottom = ''
    else:
        pw_radius_bottom = 'border-radius:0 0 8px 8px;'

    content = f"""\
  <div style="font-size:15px;color:#c9d1dc;line-height:1.8;margin-bottom:20px;">
    尊敬的 <strong style="color:#e8eef5;">{name_display}</strong>{company_display}，您好！
  </div>

  <div style="background:linear-gradient(135deg,rgba(0,102,255,0.12) 0%,rgba(0,212,255,0.08) 100%);border:1px solid rgba(0,102,255,0.25);border-radius:10px;padding:20px 24px;margin-bottom:24px;">
    <div style="font-size:16px;font-weight:700;color:#60a5fa;margin-bottom:8px;">&#9733; 欢迎加入 Spark Monitor</div>
    <div style="font-size:14px;color:#c9d1dc;line-height:1.7;">
      我们已为您开通了 Spark Monitor 企业级全球情报决策平台账户。以下是您的登录信息，请妥善保管。
    </div>
  </div>

  <div style="margin-bottom:24px;">
    <div style="font-size:13px;color:#8b96b1;margin-bottom:8px;">账户信息</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;">
      <tr>
        <td style="padding:10px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px 8px 0 0;">
          <span style="font-size:12px;color:#8b96b1;">登录邮箱</span><br>
          <span style="font-size:15px;color:#e8eef5;font-weight:600;">{to_email}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-top:none;{pw_radius_bottom}">
          <span style="font-size:12px;color:#8b96b1;">初始密码</span><br>
          <span style="font-size:16px;color:#fbbf24;font-weight:700;font-family:'Courier New',monospace;letter-spacing:1px;">{password}</span>
        </td>
      </tr>
      {expires_html}
    </table>
  </div>

  <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:8px;padding:14px 18px;margin-bottom:24px;">
    <div style="font-size:13px;color:#fbbf24;line-height:1.7;">
      &#9888; <strong>安全提示</strong>：首次登录后，建议您尽快修改初始密码以保障账户安全。
    </div>
  </div>

  <div style="text-align:center;padding:4px 0 20px;">
    <a href="{login_url or '#'}" style="display:inline-block;background:linear-gradient(135deg,#0066ff 0%,#00d4ff 100%);color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 40px;border-radius:8px;letter-spacing:0.5px;">登录 Spark Monitor</a>
  </div>

  <div style="font-size:13px;color:#8b96b1;line-height:1.7;">
    平台功能包括：全球情报监控、AI 政策分析、企业定制报告、产业洞察等。如有任何使用疑问，请随时联系我们。
  </div>"""

    text_body = (
        f'{name_display}，您好！\n\n'
        f'我们已为您开通 Spark Monitor 平台账户。\n\n'
        f'登录邮箱：{to_email}\n'
        f'初始密码：{password}\n'
        f'{expires_text}'
        f'\n首次登录后请尽快修改密码。\n'
        f'如有疑问请联系：hekong@spdt.freeqiye.com'
    )
    return _send(to_email, '【Spark Monitor】您的账户已开通 — 登录信息', text_body, _wrap_email_body(content))
