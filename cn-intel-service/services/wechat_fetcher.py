"""WeChat article content fetcher.
Extracts article text from mp.weixin.qq.com URLs.

Strategy (in order):
1. Try with desktop browser UA → extract <div id="js_content">
2. Try with WeChat-internal mobile UA → extract js_content
3. Try Playwright headless browser (renders JS)

NOTE: WeChat frequently blocks automated fetching with a captcha/verify page.
When all strategies fail, the UI shows the article summary + "查看原文" link.
"""

import re
import html as html_module
import logging
import requests

logger = logging.getLogger('cn-intel.wechat')

_DESKTOP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://mp.weixin.qq.com/',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
}

_WECHAT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.43(0x18002b2e) NetType/WIFI Language/zh_CN',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Connection': 'keep-alive',
}

_TIMEOUT = 15


def fetch_wechat_article(url):
    """Fetch and extract content from a WeChat public article URL.

    Returns dict: {'content': '<html content>', 'plainText': 'text only'}
    or None if fetch/extract fails.
    """
    if not url or 'mp.weixin.qq.com' not in url:
        return None

    # Strategy 1: Desktop UA
    result = _try_fetch(url, _DESKTOP_HEADERS)
    if result:
        return result

    # Strategy 2: WeChat internal UA
    result = _try_fetch(url, _WECHAT_HEADERS)
    if result:
        return result

    # Strategy 3: Playwright headless browser
    result = _try_fetch_playwright(url)
    if result:
        return result

    logger.warning(f'WeChat fetch: all strategies failed for {url[:80]}')
    return None


def _try_fetch(url, headers):
    """Attempt to fetch and extract content with given headers."""
    try:
        resp = requests.get(url, headers=headers, timeout=_TIMEOUT, allow_redirects=True)
        if resp.status_code != 200:
            return None

        html = resp.text
        if not html or len(html) < 500:
            return None

        # Detect verify/captcha page early
        if 'PAGE_MID' in html and 'verify' in html:
            return None

        content_html = (
            _extract_js_content(html) or
            _extract_rich_media(html) or
            _extract_js_variable(html)
        )

        if not content_html or len(content_html.strip()) < 20:
            return None

        content_html = _clean_html(content_html)
        plain_text = _html_to_plain(content_html)

        if len(plain_text) < 20:
            return None

        logger.warning(f'WeChat fetch OK (requests): {len(plain_text)} chars from {url[:60]}')
        return {
            'content': content_html,
            'plainText': plain_text,
        }

    except requests.Timeout:
        return None
    except Exception as e:
        logger.warning(f'WeChat fetch error: {e}')
        return None


def _try_fetch_playwright(url):
    """Use Playwright headless Chromium as last resort."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                locale='zh-CN',
                viewport={'width': 1280, 'height': 900},
            )
            page = context.new_page()
            page.goto(url, wait_until='domcontentloaded', timeout=20000)

            try:
                page.wait_for_selector('#js_content', state='visible', timeout=8000)
            except Exception:
                pass

            # Check for verify page
            is_verify = page.evaluate('!!document.querySelector(".weui-msg")')
            if is_verify:
                browser.close()
                return None

            content_html = page.evaluate('''() => {
                const el = document.querySelector('#js_content');
                if (el && el.innerHTML.trim().length > 20) return el.innerHTML;
                const rm = document.querySelector('.rich_media_content');
                if (rm && rm.innerHTML.trim().length > 20) return rm.innerHTML;
                return null;
            }''')

            browser.close()

            if not content_html or len(content_html.strip()) < 20:
                return None

            content_html = _clean_html(content_html)
            plain_text = _html_to_plain(content_html)

            if len(plain_text) < 20:
                return None

            logger.warning(f'WeChat fetch OK (playwright): {len(plain_text)} chars from {url[:60]}')
            return {
                'content': content_html,
                'plainText': plain_text,
            }

    except Exception as e:
        logger.warning(f'Playwright WeChat fetch error: {e}')
        return None


# --------------- HTML helpers ---------------

def _html_to_plain(content_html):
    plain_text = re.sub(r'<[^>]+>', '', content_html)
    plain_text = re.sub(r'&nbsp;', ' ', plain_text)
    plain_text = html_module.unescape(plain_text)
    plain_text = re.sub(r'\s+', ' ', plain_text).strip()
    return plain_text


def _extract_js_content(html):
    start = re.search(r'<div[^>]*\bid=["\']js_content["\'][^>]*>', html, re.IGNORECASE)
    if not start:
        return None
    remaining = html[start.end():]
    depth = 1
    pos = 0
    while depth > 0 and pos < len(remaining):
        open_m = re.search(r'<div[\s>]', remaining[pos:], re.IGNORECASE)
        close_m = re.search(r'</div>', remaining[pos:], re.IGNORECASE)
        if not close_m:
            break
        if open_m and open_m.start() < close_m.start():
            depth += 1
            pos += open_m.end()
        else:
            depth -= 1
            if depth == 0:
                return remaining[:pos + close_m.start()].strip()
            pos += close_m.end()
    return None


def _extract_rich_media(html):
    start = re.search(
        r'<div[^>]*class=["\'][^"\']*rich_media_content[^"\']*["\'][^>]*>',
        html, re.IGNORECASE,
    )
    if not start:
        return None
    remaining = html[start.end():]
    depth = 1
    pos = 0
    while depth > 0 and pos < len(remaining):
        open_m = re.search(r'<div[\s>]', remaining[pos:], re.IGNORECASE)
        close_m = re.search(r'</div>', remaining[pos:], re.IGNORECASE)
        if not close_m:
            break
        if open_m and open_m.start() < close_m.start():
            depth += 1
            pos += open_m.end()
        else:
            depth -= 1
            if depth == 0:
                return remaining[:pos + close_m.start()].strip()
            pos += close_m.end()
    return None


def _extract_js_variable(html):
    m = re.search(r"var\s+content\s*=\s*['\"](.+?)['\"]\.replace", html, re.DOTALL)
    if m:
        return html_module.unescape(m.group(1))
    m = re.search(r'var\s+content\s*=\s*[\'"](.{100,}?)[\'"];', html, re.DOTALL)
    if m:
        return html_module.unescape(m.group(1))
    return None


def _clean_html(content):
    content = re.sub(r'\s*visibility\s*:\s*hidden\s*;?', '', content)
    content = re.sub(r'\s+style="\s*"', '', content)
    content = re.sub(r'\s+data-[\w-]+="[^"]*"', '', content)
    content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL | re.IGNORECASE)
    content = re.sub(r'<noscript[^>]*>.*?</noscript>', '', content, flags=re.DOTALL | re.IGNORECASE)
    content = re.sub(r'<img[^>]*(?:width=["\']0|height=["\']0|1px)[^>]*/?>', '', content, flags=re.IGNORECASE)
    content = re.sub(r'\n{3,}', '\n\n', content)
    return content.strip()
