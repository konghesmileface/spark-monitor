"""Article content fetcher for Chinese government/media/social websites.

Site-specific CSS selectors + generic fallback for extracting article body text.
Strips navigation, share widgets, breadcrumbs, footers, and other page chrome.
Converts relative image URLs to absolute. Hides broken/tracking images.
"""

import re
import logging
import requests
from urllib.parse import urlparse, urljoin
from bs4 import BeautifulSoup, Tag

logger = logging.getLogger('cn-intel.article-fetcher')

_TIMEOUT = 15
_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
_NO_PROXY = {'http': None, 'https': None}
_WITH_PROXY = {'http': 'http://127.0.0.1:17890', 'https': 'http://127.0.0.1:17890'}

# Domains known to be JS-SPA (cannot extract content via requests)
_JS_SPA_DOMAINS = {
    'cankaoxiaoxi.com',  # ckxx.net removed — handled via contentTxt extractor below
    'weibo.com',
    # toutiao.com, wallstreetcn.com removed — handled via API fetcher below
    'douyin.com', 'zhihu.com', 'tieba.baidu.com',
    'baidu.com',  # search pages + baijiahao (WAF captcha blocks requests)
    'xueqiu.com', 'coolapk.com',
    'xiaohongshu.com',  # JS-SPA, returns footer/ICP junk without JS rendering
    # cnstock.com removed — Next.js SSR, extractable via __NEXT_DATA__
    # JS-rendered SPAs: content only loads in browser
    'chongbuluo.com',
    'kaopu.news', 'kaopu.com',
    'mktnews.com', 'mktnews.net',
    'jin10.com',
    # nfra.gov.cn: JS SPA, but handled via PDF-based API fetcher below
}
# Removed from JS_SPA (verified SSR — content extractable via requests):
#   v2ex.com (div.topic_content), gelonghui.com (article), zaobao.com (article),
#   sputniknews.cn (div.article__body), ifeng.com (div[class*="index_text_"]),
#   sspai.com (div.article-body), juejin.cn (div.markdown-body)
# Note: bilibili.com and toutiao.com — handled via API-based fetchers below

# Domains protected by WAF (Akamai/Cloudflare) — requires Playwright headless browser
_WAF_DOMAINS = {
    'imf.org',  # Akamai WAF blocks requests, needs real browser TLS fingerprint
}

# Domains that need proxy (international sites)
_PROXY_DOMAINS = {
    'federalreserve.gov', 'ecb.europa.eu', 'boj.or.jp', 'bankofengland.co.uk',
    'imf.org', 'worldbank.org', 'bis.org', 'reuters.com', 'bloomberg.com',
    'ft.com', 'wsj.com', 'nikkei.com', 'cnbc.com',
    'swissinfo.ch',
    'zaobao.com', 'zaochenbao.com',  # 联合早报 (Singapore, blocked in China)
    'v2ex.com',  # DNS/connect timeout without proxy
    'dw.com', 'rfi.fr', 'aljazeera.net',  # 靠谱新闻源 (international media)
    'nhk.or.jp', 'radio-canada.ca',
}

# ── Domain → CSS selector mapping ──────────────────────────────────────
# Each value is a list of selectors to try in order for that domain.
# First match with >50 chars of text wins.
_DOMAIN_SELECTORS: dict[str, list[str]] = {
    # ─── 央媒 Central Media ───
    'people.com.cn':       ['div#rm_txt_zw', 'div.show_text', 'div.rm_txt_con', 'div#rwb_zw',
                            'div.box_con', 'div.text_con'],
    'paper.people.com.cn': ['div#rm_txt_zw', 'div.show_text', 'div.rm_txt_con', 'div#rwb_zw',
                            'div.text_con'],
    'health.people.com.cn': ['div.artDet', 'div.rm_txt_con', 'div#rwb_zw'],
    'news.cn':             ['div#detail', 'div.detail', 'div#p-detail', 'span.detailContent'],
    'cctv.com':            ['div.cnt_bd', 'div.content_area', 'div#content_area'],
    'ce.cn':               ['div.TRS_Editor', 'div.trs_editor_view', 'div.content.clearfix'],

    # ─── 国务院/部委 Government ───
    'gov.cn':              ['div#UCAP-CONTENT', 'div.pages_content', 'div.article.onemark'],
    'pbc.gov.cn':          ['div#zoom', 'div.zoom1', 'div.TRS_Editor'],
    'mof.gov.cn':          ['div.TRS_Editor', 'div#zoom', 'div.my_conarea'],
    'ndrc.gov.cn':         ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    # CSRC: TRS_Editor in main content, NOT footer. Use #ContentRegion first.
    'csrc.gov.cn':         ['div#ContentRegion', 'div.article-content', 'td.content_area div.TRS_Editor',
                            'div.main-content div.TRS_Editor', 'div#mainContent div.TRS_Editor',
                            'div.detail div.TRS_Editor'],
    'nfra.gov.cn':         ['div.detail-content', 'div.article-content',
                            'div.main-content div.TRS_Editor', 'div.TRS_Editor'],
    'stats.gov.cn':        ['div.trs_editor_view', 'div.center_xilan', 'div.TRS_Editor'],
    'mofcom.gov.cn':       ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div#zoom'],
    'safe.gov.cn':         ['div.detail_content', 'div#content', 'div.TRS_Editor', 'div#UCAP-CONTENT'],
    'ccdi.gov.cn':         ['div.TRS_Editor', 'div#content', 'div.content'],
    'audit.gov.cn':        ['div#textSize', 'div.con-article-txt-box', 'div.TRS_Editor'],
    'mot.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    'moa.gov.cn':          ['div.gsj_htmlcon_bot', 'div.Custom_UnionStyle', 'div.gsj_htmlcon',
                            'div.TRS_Editor', 'div#UCAP-CONTENT', 'div.trs_editor_view'],
    'most.gov.cn':         ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    'mee.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.con_text'],
    'mwr.gov.cn':          ['div.view', 'div.TRS_UEDITOR', 'div.xlcontainer',
                            'div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    'mem.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    'chinatax.gov.cn':     ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.detail-content'],
    'sasac.gov.cn':        ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    'miit.gov.cn':         ['div#UCAP-CONTENT', 'div.TRS_Editor', 'div.xxgk_detail'],
    'mohurd.gov.cn':       ['div.editor-content', 'div.editorContent-box', 'div.TRS_Editor', 'div#UCAP-CONTENT'],
    'customs.gov.cn':      ['div.easysite-news-text', 'div.TRS_Editor', 'div#UCAP-CONTENT'],
    'mfa.gov.cn':          ['div#News_Body_Txt_A', 'div.news-main', 'div#Zoom', 'div.TRS_Editor'],
    'fmprc.gov.cn':        ['div#News_Body_Txt_A', 'div.news-main', 'div#Zoom', 'div.TRS_Editor'],
    'mohrss.gov.cn':       ['div.TRS_Editor', 'div#zoom', 'div#UCAP-CONTENT', 'div.article_con'],
    'sse.com.cn':          ['div.article-content', 'div.allZoom', 'div#content'],
    'szse.cn':             ['div#desContent', 'div.des-content', 'div.des-cont', 'div.article-content'],
    'nhc.gov.cn':          ['div.TRS_Editor', 'div#zoom', 'div#UCAP-CONTENT', 'div.con_text'],
    'moe.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.moe_content'],
    'mct.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT'],
    'mnr.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT'],
    'samr.gov.cn':         ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_content'],
    'mva.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT'],
    'nea.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.artcle'],
    'moj.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT'],
    'mca.gov.cn':          ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.article_con'],
    'nhsa.gov.cn':         ['div.TRS_Editor', 'div#UCAP-CONTENT', 'div.content'],
    'qstheory.cn':         ['div.highlight', 'div.TRS_Editor', 'div.article'],

    # ─── 财经媒体 Financial Media ───
    'yicai.com':           ['div.m-text div.f-cb', 'div.f-cb', 'article.a-art'],
    'caixin.com':          ['div#Main_Content_Val', 'div.textbox', 'div.text'],
    'stcn.com':            ['div.detail-content-wrapper', 'div.txt_con', 'div.detail_content'],
    'cs.com.cn':           ['div.article_content', 'div#artibody', 'div.article-body'],
    'cnstock.com':         ['div#qmt_content_div', 'div.content', 'div.article-content'],
    '21jingji.com':        ['div.article-content', 'div.article__content', 'article'],
    'nbd.com.cn':          ['div.article-content', 'div.g-article-content', 'div.detail-content'],
    'jiemian.com':         ['div.article-content', 'div.article_main', 'div.article-body'],
    'jjckb.cn':            ['div#articleContent', 'div.article-content', 'div.detail', 'div.TRS_Editor'],
    'eeo.com.cn':          ['div.article-content', 'div.artical-content', 'div.detail_txt', 'div.content'],
    'bse.cn':              ['div.content-detail', 'div.article-content', 'div.TRS_Editor'],
    'thepaper.cn':         ['div.news_txt', 'div.newsdetail_content', 'div.index_cententWrap'],
    'cailianshe.com':      ['div.detail-content', 'div.article-content', 'article'],
    'wallstreetcn.com':    ['article.article__content', 'div.article__content', 'div.rich_media_content'],
    'gelonghui.com':       ['article', 'div.article-content', 'div.article-body'],
    'jin10.com':           ['div.article-content', 'div.detail-content'],
    'cls.cn':              ['div.detail-telegraph-content', 'div.m-b-40', 'div.detail-content', 'div.article-content'],

    # ─── 综合资讯 News Portals ───
    'ifeng.com':           ['div[class*="index_text_"]', 'div[class*="index_main_content_"]',
                            'div[class*="index_content_"]', 'div#main_content', 'div.text-3w'],
    'qq.com':              ['div.content-article', 'div.Cnt-Main-Article-QQ', 'div.rich_media_content'],
    'cankaoxiaoxi.com':    ['div.article-content', 'div.detail-content'],
    'zaobao.com':          ['article', 'div.article-content-rawhtml', 'div#content-body-4952'],
    'zaochenbao.com':      ['article', 'div.article-content-rawhtml', 'div#content-body-4952'],
    'sputniknews.cn':      ['div.article__body', 'div.white-longread',
                            'div.article__text', 'div.article-body'],

    # ─── 智库 Think Tanks ───
    'cssn.cn':             ['div.TRS_Editor', 'div.artCon', 'div.article-content'],
    'ciis.org.cn':         ['div.TRS_Editor', 'div.article-content', 'div.content'],

    # ─── Sina Finance / regional (sina regional pages have nav inside #artibody) ───
    'sina.com.cn':         ['div.article-body', 'div#artibody', 'div.article', 'div.article-content'],

    # ─── 更多财经/新闻媒体 (搜索引擎结果常见来源) ───
    '10jqka.com.cn':       ['div.article-content', 'div.news-content', 'div.atc-content'],
    'eastmoney.com':       ['div.article-content', 'div.txtinfos', 'div#ContentBody',
                            'div.newsContent', 'div.b-review-main'],
    'bjd.com.cn':          ['div.article-content', 'div.detail-content', 'article'],
    'bjnews.com.cn':       ['div.article-text', 'article', 'div.article-content'],
    'china.com':           ['div#chan_newsDetail', 'div#chan_newsBlk', 'div.chan_newsInfo_body'],
    'chinanews.com':       ['div.left_zw', 'div.left-content', 'div.content_maincontent_more'],
    'huanqiu.com':         ['div.la_con', 'div.text', 'div.article-content'],
    'gmw.cn':              ['div.u-mainText', 'div#contentMain', 'div.article-content', 'article'],
    '360kuai.com':         ['div.article-content', 'div.content', 'article'],
    'youth.cn':            ['div.TRS_Editor', 'div.article-content', 'div.content'],

    # ─── 教育/招考 (搜索引擎结果常见来源) ───
    'offcn.com':           ['div.zg_articlecon', 'div.detail-content', 'div.article'],
    'huatu.com':           ['div.article-detail', 'div.detail-main', 'div.content', 'article'],
    'cinic.org.cn':        ['div.con-box', 'div.content-article', 'div.article-content', 'article'],
    'mysteel.com':         ['div.article-body', 'div.article-content', 'div.newsContent', 'article'],

    # ─── International news (kaopu external links) ───
    'hani.co.kr':          ['div.article-contents', 'div.article-view', 'article'],
    'china.hani.co.kr':    ['div.article-contents', 'div.article-view', 'article'],
    'swissinfo.ch':        ['div.article-main', 'article', 'div.lead-text'],
    'dw.com':              ['div.rich-text', 'article', 'div.longText'],
    'rfi.fr':              ['div.article__text', 'div.article-body', 'article'],
    'aljazeera.net':       ['div.wysiwyg', 'article', 'div.article-body'],
    'nhk.or.jp':           ['div.body-text', 'article', 'div.article-body'],
    'radio-canada.ca':     ['div.document-simple-text', 'div.article-body', 'article'],

    # ─── 科技/社区 Tech ───
    '36kr.com':            ['div.article-content', 'div.articleDetailContent',
                            'div.newsflash-item', 'div.kr-rich-text-wrapper'],
    'ithome.com':          ['div#paragraph', 'div.post_content'],
    'sspai.com':           ['div.article-body', 'article.article'],
    'xueqiu.com':          ['div.article__bd__detail', 'div.detail__content'],
    'juejin.cn':           ['div.article-content', 'div.markdown-body'],
    'v2ex.com':            ['div.topic_content', 'div.markdown_body', 'div.cell'],
    'chongbuluo.com':      ['div.content', 'article.article'],

    # ─── 社交平台 Social ───
    'weibo.com':           ['div.card-feed div.content', 'div.WB_text'],
    'zhihu.com':           ['div.RichContent-inner', 'div.Post-RichText', 'span.RichText'],
    'bilibili.com':        ['div.article-content', 'div.opus-module-content'],
    'toutiao.com':         ['article.article-content', 'div.article-content'],
    'douban.com':          ['div#link-report', 'div.note', 'div.review-content'],
    'coolapk.com':         ['div.feed-detail-content', 'div.article-content'],
    'hupu.com':            ['div.article-content', 'div.thread-content-detail'],
    'nowcoder.com':        ['div.post-topic-des', 'div.article-content'],
    'tieba.baidu.com':     ['div.d_post_content', 'div.post_bubble_middle'],

    # ─── WeChat Articles ───
    'mp.weixin.qq.com':    ['div#js_content', 'div.rich_media_content'],

    # ─── International Sources ───
    'federalreserve.gov':  ['div#article', 'div.col-xs-12', 'div#content'],
    'ecb.europa.eu':       ['main', 'div#main-wrapper', 'div.section--content', 'div.content-box'],
    'reuters.com':         ['div.article-body__content', 'article.article', 'div[data-testid="ArticleBody"]'],
    'cnbc.com':            ['div.ArticleBody-articleBody', 'div.group', 'div.RenderKeyPoints-list'],
    'imf.org':             ['div.content', 'div#content', 'div.text-content'],
    'worldbank.org':       ['div.content-field', 'div.rich-text', 'article.content'],
    'boj.or.jp':           ['div#main', 'div.main-content', 'div.right_contents'],
    'bankofengland.co.uk': ['div.page-content', 'article.news-release', 'div#content', 'div.rich-text'],
    'bis.org':             ['div#cmsContent', 'div.cb-text-block', 'article', 'div.mainContent'],
    'nikkei.com':          ['div.article-body', 'section.container_czMOQ'],
    'ft.com':              ['div.article-body', 'div.content-body', 'article.article'],
}

# ── Noise element patterns to remove ──────────────────────────────────
_NOISE_SELECTORS = [
    # Share widgets
    'div.share', 'div.share-bar', 'div.shareBox', 'div.bshare-custom',
    'div.bdshare_t', 'div.social-share', 'div.weixin-share', 'a.bshare-more',
    # Navigation & breadcrumbs
    'div.crumb', 'div.breadcrumb', 'nav', 'div.path', 'div.position',
    'div.location', 'div.nav', 'div.subnav', 'div.crumbs',
    # Sidebars & related
    'div.sidebar', 'aside', 'div.related', 'div.recommend',
    'div.hot-news', 'div.more-news', 'div.relative',
    # Font controls & tools
    'div.tools', 'div.fontzoom', 'div.font-size', 'span.fontzoom_btn',
    'div.article-tools', 'div.art_tools', 'div.print',
    'div[font]', 'span[font]',  # mohrss.gov.cn: <div font="12">小</div>
    # Headers in content area (author, source, date duplicates)
    'div.info', 'div.article-info', 'div.source', 'div.author',
    'div.artInfo', 'div.article-source',
    # Feedback & comments
    'div.comment', 'div.feedback', 'div#comment', 'div.discuss',
    # Editor/reporter info
    'div.editor', 'span.editor', 'div.zrbj', 'p.zrbj',
    # Ads
    'div.ad', 'div.advertisement', 'ins.adsbygoogle',
    # Forms & interactive elements (dropdowns, search, etc.)
    'select', 'form', 'input', 'textarea', 'button',
    # Footer elements
    'div.foot', 'div.footer', 'footer', 'div.copyright',
    'div.bottom-bar', 'div.page-footer',
    # Print/close toolbars
    'div.picTool',
    # CSRC/gov specific: site-wide link bars
    'div.sy_bottom', 'div.footer_nav', 'div.foot_link',
    'div.webInfo', 'div.copy_right',
    # 21jingji.com trailing recommendation lists
    'div.article-recommend', 'div.article-related', 'div.article_recommend',
    'ul.article-list', 'div.article-footer',
    # "延伸阅读" / "相关阅读" / "热点视频" trailing sections
    'div.extend-read', 'div.related-read', 'div.hot-video',
    'div.ydsj_box', 'div.ydsj',  # cinic.org.cn "延伸阅读"
    # stcn.com (证券时报) noise
    'div.social-bar', 'div.detail-content-editor', 'div.detail-content-tags',
    'div.stock-tags', 'div.detail-content-statement',
    'div.list-page-tab', 'ul.list',
    # people.com.cn category header & navigation
    'div.channel_nav', 'div.header', 'div.top', 'div.hot_word',
    # thepaper header noise
    'div.header_wrapper', 'div.topArea', 'div.top_area',
    'div.index_header', 'div.headimg_area',
    # qq.com / tencent hero images and header
    'div.LEFT', 'div.qq_logo', 'div.header-content',
    'div.content-header', 'div.article-title',
    # thepaper extra noise
    'div.news_about', 'div.news_author', 'div.news_keyword',
    'div[class*="headerContainer"]', 'div[class*="index_left_content_"]',
    # Sina Finance / regional sidebar + header junk
    'div.article-bottom', 'div.article_bottom', 'div.finance-app-download',
    'div.app-kaihu', 'div.blk_ht_01', 'div.blk_ht_02',
    'div.article-editor', 'p.article-editor',
    'div.nav-mod', 'div.channel-nav', 'ul.nav-list',   # Sina regional nav
    'div.date-source', 'span.date', 'span.source',     # Sina date/source bar
    'div.article-hd', 'div.art_hd',                    # Sina article header
    'div#j_comment', 'div.comment-area',                # Sina comments
    'div.sina-adfloat', 'div.sina-extension',           # Sina ads
    'div.article-tags', 'div.module-chuangyi-gg',       # Sina article tags & ad creative
    # 10jqka.com.cn (同花顺) noise
    'div.news-header', 'div.news-info', 'div.stock-relate',
    'div.hot-stock', 'div.article-footer',
    # eastmoney.com noise
    'div.em_media', 'div.hot-article', 'div.related-article',
    'div#J_ArtHeader', 'div.article-header',
    # chinanews.com noise
    'div.left_nav', 'div.left_title', 'div.content_jjgd',
    # Generic: channel/category navigation inside article area
    'ul.channel-nav', 'div.category-nav', 'div.subnav-list',
    # swissinfo.ch noise
    'div.related-content', 'div.cta-block', 'div.reaction-block',
    # sputniknews related articles
    'div.article__block[data-type="article"]',
    'div.article__block[data-type="banner"]',
    'div.article__block[data-type="media"]',
    # Fed share widget & related content
    'div.share-tools', 'ul.list-inline', 'div.related-content',
    # people.com.cn toolbar & audio
    'p.dyue', 'div.voice-wrap', 'div.voice-container', 'div.edit',
    'div.text_title', 'div.text_c > h1', 'div.text_c > h3',
    'p.sou',  # date/source line above article
    # IMF social sharing (ul.social-hz = follow icons, ShareThis = share buttons)
    'ul.social-hz',
    'div.col-xs-12.col-sm-8.col-md-8 > div.row',
    'i[aria-label*="sharing"]',  # ShareThis: facebook/twitter/email/copy/print sharing
    'img[src*="sharethis.com"]',  # ShareThis CDN icons
    # ECB navigation & address blocks
    'div.address-box', 'div.ecb-langSelector',
    # nbd.com.cn noise
    'div.article-source-wrap', 'div.article-tag', 'div.article-share',
    # jiemian.com noise
    'div.article-tag', 'div.article-source', 'div.article-share-wrap',
    # eeo.com.cn noise
    'div.article-tag', 'div.article-share', 'div.article_bottom',
    # bse.cn noise
    'div.news-source', 'div.news-tools', 'div.share-box',
    # paper.people.com.cn (报纸版) — edition navigation & toolbar
    'div.paper_num', 'div.ban_list', 'div.date_area',
    'div.btn_area', 'div.tools_area', 'ul.ban_list',
    'div.rmrb_detail_top', 'div.rmrb_detail_bottom',
]

# Text patterns to strip from final output
_NOISE_TEXT_PATTERNS = [
    r'分享到\s*[:：]?\s*(微信|微博|QQ|朋友圈|新浪|人人|LinkedIn)',
    r'(字体|字号)\s*[:：]?\s*(小|中|大|超大|Aa)',
    r'责任编辑\s*[:：]\s*\S+',
    r'编辑\s*[:：]\s*\S+',
    r'^\s*>>\s*返回.*$',
    r'打印本页\s*',
    r'关闭窗口\s*',
    r'收藏本文\s*',
    r'纠错\s*',
    r'^\s*\[\s*字号\s*[:：]',
    r'^\s*【发布时间[：:]\s*\d{4}.*】\s*$',
    r'^\s*【来源[：:].*】\s*$',
    r'^\s*字号\s*[：:]\s*【?大】?\s*【?中】?\s*【?小】?\s*$',
    r'^\s*[大中小]\s*$',  # Standalone single-char font-size labels (mohrss.gov.cn)
    r'^\s*【关闭】\s*【打印】\s*$',
    r'^\s*字体\s*[：:]\s*大\s*中\s*小\s*$',
    r'^\s*首页\s*[>›»/]\s*',
    r'^\s*当前位置\s*[:：]',
    r'^\d{4}[/-]\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2}\s*$',
    # ICP/copyright/legal lines
    r'京ICP[备证]\s*\S+',
    r'京公网安备\s*\S+',
    r'网站识别码\s*[:：]\s*\S+',
    r'主办单位\s*[:：]\s*.{2,30}',
    r'版权所有\s*[:：]\s*.{2,30}',
    r'联系我们\s*[|｜]\s*法律声明',
    r'归档数据\s*$',
    r'政府网站年度报表\s*$',
    r'行业相关网站\s*$',
    r'^\s*链接\s*[:：]\s*$',
    r'^\s*来源\s*[:：]\s*\S+\s*$',
    r'^\s*文章来源\s*[:：]\s*.{2,40}\s*$',
    # people.com.cn trailing (责编：XXX、YYY)
    r'\(责编\s*[:：]\s*.{2,30}\)',
    r'^\s*责编\s*[:：]\s*$',
    # people.com.cn toolbar text
    r'^\s*订阅\s*$',
    r'^\s*取消订阅\s*$',
    r'^\s*已收藏\s*$',
    r'^\s*(大字号|小字号)\s*$',
    r'^\s*点击播报本文.*$',
    r'^\s*222\s*$',  # people.com.cn listen count
    # paper.people.com.cn (报纸版) edition listings & navigation
    r'^\s*\d{2}版\s*[:：].*$',  # "01版：要闻", "03版：要闻·财经"
    r'^\s*人民日报(海外版)?\s*$',
    r'^\s*\d{4}年\d{2}月\d{2}日\s*$',  # standalone date line
    r'^\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*$',  # standalone weekday
    r'^\s*返回目录\s*$',
    r'^\s*全文复制\s*$',
    r'^\s*(上一篇|下一篇)\s*$',
    # water ministry header noise
    r'^\s*欢迎您来到.*网站[！!]?\s*$',
    r'^\s*EN\s*$',
    r'^\s*无障碍阅读\s*$',
    r'^\s*欢迎使用.*智能搜索\s*$',
    r'^\s*【\s*中\s*小\s*】\s*$',
    r'^\s*打印\s*$',
    r'^\s*本站讯\s*',
    # SASAC / gov trailing noise
    r'^\s*扫一扫在手机.*打开.*$',
    r'^\s*【\s*扫一扫.*】\s*$',
    # 21jingji / media trailing recommendation text
    r'^\s*查看全部\s*$',
    r'^\s*公告\s*$',
    r'^\s*回复\s*$',
    # thepaper header noise
    r'^\s*下载客户端\s*$',
    r'^\s*登录\s*$',
    r'^\s*无障碍\s*$',
    r'^\s*澎湃新闻\s*$',
    r'^\s*澎湃号\s*$',
    r'^\s*听全文\s*$',
    r'^\s*中国政库\s*$',
    r'^\s*\+\d+\s*$',
    r'^\s*[∙·•]\s*$',
    # qq.com / tencent header noise
    r'^\s*腾讯网\s*$',
    # Sina Finance tail noise
    r'海量资讯.*尽在新浪财经APP',
    r'登录新浪财经APP\s*搜索.*$',  # Sina finance "登录APP搜索信披" promo
    r'^\s*新浪财经公众号\s*$',
    r'24小时滚动播报.*关注\s*（\w+\）',
    r'^\s*VIP课程推荐\s*$',
    r'^\s*APP专享直播\s*$',
    r'^\s*热门推荐\s*$',
    r'^\s*加载中...\s*$',
    r'^\s*相关新闻\s*$',
    r'^\s*收起\s*$',
    r'^\s*股市直播\s*$',
    r'^\s*7X24小时\s*$',
    r'^\s*图文直播间\s*$',
    r'^\s*视频直播间\s*$',
    r'^\s*最近访问\s*$',
    r'^\s*我的自选\s*$',
    r'^\s*上一页\s*下一页\s*$',
    r'^\s*\d+/\d+\s*$',  # "1/10" pagination
    # thepaper extra
    r'^\s*大国外交\s*[>›»]?\s*$',
    r'^\s*来源\s*[:：]\s*澎湃新闻\s*$',
    # 36kr share noise
    r'^\s*分享至\s*$',
    r'打开微信.*分享按钮',
    # stcn.com (证券时报) noise
    r'^\s*为你推荐\s*$',
    r'^\s*点赞\s*$',
    r'^\s*分享\s*$',
    r'^\s*网友评论\s*$',
    r'^\s*暂无评论\s*$',
    r'^\s*登录\s*后可以发言\s*$',
    r'^\s*发送\s*$',
    r'网友评论仅供其表达个人看法.*',
    r'声明\s*[:：]\s*证券时报力求信息真实.*',
    r'下载.*证券时报.*官方APP.*',
    r'^\s*校对\s*[:：]\s*\S+\s*$',
    # swissinfo noise
    r'^\s*正在讨论\s*$',
    r'^\s*请加入我们.*$',
    r'.*chinese@swissinfo\.ch.*',
    r'^\s*更多阅览\s*$',
    r'^\s*此内容发布于.*$',
    r'^\s*符合JTI标准\s*$',
    r'^\s*相关内容\s*[:：]?\s*$',
    r'^\s*其他\d+种语言\s*$',
    # Fed/international noise
    r'^\s*Share\s*$',
    r'^\s*Related Content\s*$',
    r'^\s*Board Votes\s*$',
    r'^\s*Order \(PDF\)\s*$',
    r'^\s*Last Update\s*[:：]?\s*',
    r'^\s*Page Content\s*$',
    r'^\s*image\d+\s*$',
    r'For media inquiries.*\d{3}-\d{3}-\d{4}',
    r'\[email protected\]',
    # ECB noise
    r'^\s*PRESS RELEASE\s*$',
    r'^\s*ANYTIME\s*$',
    r'^\s*PAST MONTH\s*$',
    r'^\s*PAST YEAR\s*$',
    r'^\s*Search Options\s*$',
    r'^\s*Image Preview\s*$',
    # MOF regional subdomains: "2026年3月12日 来源：财政部黑龙江监管局"
    r'^\s*\d{4}年\d{1,2}月\d{1,2}日\s*来源\s*[:：].*$',
    # Bare "分享到：" without platform name (tv.cctv.com)
    r'^\s*分享到\s*[:：]?\s*$',
    # MOT 信息公开 metadata block
    r'^\s*(文\s*号|索引号|公开日期|主题词|机构分类|主题分类|公文类型)\s*[:：].*$',
    # MOT/gov font size controls with brackets
    r'^\s*【[大中小]+】.*【?打印】?\s*$',
    # xinhuanet CTA
    r'点击.*观看更多精彩.*$',
    # nbd.com.cn (每日经济新闻) noise
    r'如需转载请与.*联系',
    r'^\s*每日经济新闻\s*$',
    r'^\s*封面图片来源\s*[:：].*$',
    # Photo captions with source attribution (repeated in xinhua/people articles)
    r'图片来源\s*[:：]\s*\S+[）\)]\s*$',
    # Page navigation controls
    r'^\s*【\s*TOP\s*】\s*$',
    r'^\s*【\s*打印页面\s*】\s*$',
    r'^\s*【\s*关闭页面\s*】\s*$',
    r'^\s*【TOP】\s*【打印页面】\s*【关闭页面】\s*$',
    # Reposting site headers (gov.cn subdomain gateway labels)
    r'^\s*\S{2,10}(市|区|县|省)人民政府门户网站\s*$',
    # Orphaned font control fragment
    r'^\s*【字体\s*[:：]?\s*$',
    # jiemian.com (界面新闻) noise
    r'^\s*未经授权.*不得转载\s*$',
    r'^\s*界面新闻\s*$',
    # jjckb.cn (经济参考报) noise
    r'^\s*经济参考报\s*$',
    r'^\s*新华社.*主管\s*$',
    # eeo.com.cn (经济观察报) noise
    r'^\s*经济观察报\s*$',
    r'^\s*经济观察网\s*$',
    r'版权声明\s*[:：].*经济观察.*',
    # bse.cn (北交所) noise
    r'^\s*北京证券交易所\s*$',
    # eastmoney.com noise
    r'^\s*东方财富\s*(APP|网)?\s*$',
    r'^\s*下载APP\s*$',
    r'^\s*登录注册\s*$',
    r'^\s*首页\s*$',
    r'^\s*行情中心\s*$',
    r'^\s*个股\s*$',
    r'^\s*财经\s*$',
    r'^\s*基金\s*$',
    r'^\s*期货\s*$',
    r'^\s*外汇\s*$',
    r'^\s*客户端\s*$',
    # 10jqka.com.cn (同花顺) noise
    r'^\s*同花顺\s*(财经|金融)?\s*$',
    r'^\s*扫码下载\s*$',
    # Generic navigation
    r'^\s*回到顶部\s*$',
    r'^\s*返回首页\s*$',
    r'^\s*网站地图\s*$',
    r'^\s*免责声明\s*$',
    r'^\s*联系方式\s*$',
    # Government information disclosure metadata
    r'^\s*索\s*引\s*号\s*[:：]?\s*\S*\s*$',
    r'^\s*信息分类\s*[:：].*$',
    r'^\s*内容分类\s*[:：].*$',
    r'^\s*发文日期\s*[:：].*$',
    r'^\s*发布机构\s*[:：].*$',
    r'^\s*生成日期\s*[:：].*$',
    r'^\s*来源单位\s*[:：].*$',
    r'^\s*有\s*效\s*性\s*[:：].*$',
    r'^\s*生效时间\s*[:：]?\s*$',
    r'^\s*废止时间\s*[:：]?\s*$',
    r'^\s*名\s+称\s*[:：].*$',
    r'^\s*关\s*键\s*词\s*[:：].*$',
    r'^\s*搜索热词\s*[:：].*$',
    r'^\s*(要闻动态|政务公开|政务服务|互动交流|走进\w+)\s*$',
    r'^\s*中\s+小\s*$',  # font size controls
    # Sina regional navigation & chrome
    r'^\s*新浪\w{2,4}\s*$',  # 新浪河北, 新浪财经, etc.
    r'^\s*资讯\s*$',
    r'^\s*万象\s*$',
    r'^\s*各地\s*$',
    r'^\s*评论\s*[（(]\s*\d*\s*人参与\s*[)）]\s*$',
    r'^\s*A[\-\+⁺⁻]A[\-\+⁺⁻]?\s*$',  # font size: A+A- / A⁺A⁻
    r'^\s*原标题\s*[:：]',  # strip "原标题：xxx" prefix
    # Common portal channel names (when they leak into article area)
    r'^\s*(热点|推荐|头条|视频|图片|娱乐|体育|军事|科技|教育|旅游|汽车|房产|健康|社会|民生|各地|国内|国际|互联网|数码|游戏|美食|时尚|星座|情感|财经|股票|理财|收藏)\s*$',
    # ifeng/phoenix navigation
    r'^\s*凤凰\w{2,4}\s*$',
    r'^\s*凤凰网\s*$',
    # Sohu / NetEase / Tencent portal names
    r'^\s*搜狐\w{0,4}\s*$',
    r'^\s*网易\w{0,4}\s*$',
    r'^\s*举报\s*$',
    r'^\s*反馈\s*$',
    # Generic date-source standalone lines (common pattern across many portals)
    r'^\s*\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}\s*\S{2,10}\s*$',
    # "原标题：xxx" → keep the content after colon but strip the prefix
    # (already handled above — this strips the whole line if very short)
    r'^\s*原标题\s*[:：]\s*.{0,10}\s*$',
    # people.com.cn paper edition: "返回目录 放大 缩小 全文复制 下一篇 上一篇"
    r'^\s*返回目录\s*$',
    r'^\s*全文复制\s*$',
    r'^\s*下一篇\s*$',
    r'^\s*上一篇\s*$',
    r'^\s*放大\s*$',
    r'^\s*缩小\s*$',
    # people.com.cn paper edition: "01版：要闻 02版：..." version listing
    r'^\s*\d{2}版\s*[:：]\s*.{2,20}\s*$',
    # Trailing "(文章来源：XXX)" at end of article
    r'\s*[（(]\s*文章来源\s*[:：]\s*.{2,40}[)）]\s*$',
    # Trailing "来源：XXX 编辑：YYY" multi-field line
    r'^\s*来源\s*[:：]\s*.{2,30}\s*编辑\s*[:：]\s*.{2,20}\s*$',
    # Standalone "来源：XXX" line with longer source name
    r'^\s*来源\s*[:：]\s*[\u4e00-\u9fff·•a-zA-Z]{2,30}\s*$',
    # people_overseas edition header: "人民日报海外版 2026年03月30日 Mon"
    r'^\s*人民日报海外版\s*\d{4}年\d{2}月\d{2}日.*$',
    # people_overseas "——" subtitle that's actually a standalone line
    r'^\s*——.*人民日报.*$',
    # eastmoney trailing source attribution
    r'^\s*\(文章来源\s*[:：].*\)\s*$',
    # "责编" with author names and email
    r'^\s*责编\s*[:：]\s*\S+\s+\S+\s*邮箱\s*[:：].*$',
]
_NOISE_RE = [re.compile(p, re.MULTILINE) for p in _NOISE_TEXT_PATTERNS]


_API_FETCHER_DOMAINS = {'bilibili.com', 'toutiao.com', 'wallstreetcn.com', 'ckxx.net', 'nfra.gov.cn'}

def is_api_fetcher_domain(url: str) -> bool:
    """Check if URL belongs to a domain handled by API-based fetchers (bilibili, toutiao)."""
    if not url:
        return False
    domain = _get_domain(url)
    for d in _API_FETCHER_DOMAINS:
        if domain == d or domain.endswith('.' + d):
            return True
    return False


def can_fetch(url: str) -> bool:
    """Check if a URL is fetchable (not a JS-SPA domain).
    Note: bilibili.com and toutiao.com are handled via API fetchers, not blocked here."""
    if not url:
        return False
    domain = _get_domain(url)
    for spa in _JS_SPA_DOMAINS:
        if domain == spa or domain.endswith('.' + spa):
            return False
    return True


# ── API-based content fetchers for SPA platforms ──────────────────────

def _bilibili_search_first_bvid(keyword: str) -> str | None:
    """Search Bilibili for a keyword and return the first video's bvid."""
    try:
        resp = requests.get(
            'https://api.bilibili.com/x/web-interface/search/type',
            params={'search_type': 'video', 'keyword': keyword, 'page': 1, 'page_size': 5},
            headers={
                'User-Agent': _UA,
                'Referer': 'https://search.bilibili.com/',
                'Cookie': 'buvid3=placeholder;',
            },
            timeout=10,
            proxies=_NO_PROXY,
        )
        if resp.status_code != 200 or not resp.text:
            logger.warning(f'Bilibili search HTTP {resp.status_code}, body={len(resp.text or "")} for "{keyword[:20]}"')
            return None
        results = resp.json().get('data', {}).get('result') or []
        for r in results:
            bvid = r.get('bvid', '')
            if bvid:
                logger.warning(f'Bilibili search OK: "{keyword[:20]}" → {bvid}')
                return bvid
    except Exception as e:
        logger.warning(f'Bilibili search failed for "{keyword[:30]}": {e}')
    return None


def _fetch_bilibili_api(url: str, keyword: str = '') -> dict | None:
    """Fetch B站 video info via Bilibili API.
    Extracts bvid from URL → calls view API → returns desc + stats as content.
    For search URLs (no bvid), uses search API to find the first video.
    Always returns content if the API call succeeds (shows stats even when desc is empty)."""
    m = re.search(r'/(BV[\w]+)', url)
    if not m:
        # No BV ID in URL — try to find one via search
        # Extract keyword from search URL or use provided keyword
        kw = keyword
        if not kw:
            from urllib.parse import urlparse as _urlparse, parse_qs as _parse_qs
            try:
                q = _parse_qs(_urlparse(url).query)
                kw = q.get('keyword', q.get('q', ['']))[0]
            except Exception:
                pass
        if not kw:
            return None
        bvid = _bilibili_search_first_bvid(kw)
        if not bvid:
            return None
    else:
        bvid = m.group(1)
    try:
        resp = requests.get(
            'https://api.bilibili.com/x/web-interface/view',
            params={'bvid': bvid},
            headers={
                'User-Agent': _UA,
                'Referer': 'https://www.bilibili.com/',
            },
            timeout=10,
            proxies=_NO_PROXY,
        )
        data = resp.json().get('data', {})
        if not data:
            return None
        title = data.get('title', '')
        desc = data.get('desc', '')
        if not desc or desc == '-':
            pages = data.get('pages', [])
            if pages:
                desc = pages[0].get('part', '')
        if desc == '-':
            desc = ''
        owner = (data.get('owner') or {}).get('name', '')
        stat = data.get('stat', {})
        view = stat.get('view', 0)
        like = stat.get('like', 0)
        danmaku = stat.get('danmaku', 0)
        coin = stat.get('coin', 0)
        favorite = stat.get('favorite', 0)
        share = stat.get('share', 0)
        # Tags (for context even when desc is empty)
        tname = data.get('tname', '')  # category/partition name
        dynamic = data.get('dynamic', '')  # UP主动态文案
        pubdate = data.get('pubdate', 0)
        duration = data.get('duration', 0)

        # Build informative HTML content
        parts = []
        if owner:
            parts.append(f'<p><strong>UP主:</strong> {owner}'
                         f'{" · " + tname if tname else ""}</p>')
        # Stats row
        parts.append(
            f'<p><strong>播放:</strong> {view:,} | '
            f'<strong>弹幕:</strong> {danmaku:,} | '
            f'<strong>点赞:</strong> {like:,} | '
            f'<strong>投币:</strong> {coin:,} | '
            f'<strong>收藏:</strong> {favorite:,}</p>'
        )
        # Duration
        if duration > 0:
            mins, secs = divmod(duration, 60)
            parts.append(f'<p><strong>时长:</strong> {mins}:{secs:02d}</p>')
        # Dynamic text (UP主发布时附言)
        if dynamic and dynamic != desc:
            parts.append(f'<p style="color:#999;font-style:italic">{dynamic}</p>')
        # Description
        if desc:
            parts.append(f'<div style="margin-top:12px;line-height:1.8;white-space:pre-wrap">{desc}</div>')

        content_html = '\n'.join(parts)
        plain_text = desc or dynamic or title
        logger.warning(f'Bilibili API OK: {len(plain_text)} chars for {bvid}')
        return {
            'content': content_html,
            'plainText': plain_text,
            'title': title,
        }
    except Exception as e:
        logger.warning(f'Bilibili API failed for {url[:60]}: {e}')
        return None


_TOUTIAO_MOBILE_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) '
                      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 '
                      'Mobile/15E148 Safari/604.1')


def _fetch_toutiao_article_by_id(article_id: str) -> dict | None:
    """Fetch a single Toutiao article by its item/group ID via mobile API."""
    try:
        resp = requests.get(
            f'https://m.toutiao.com/i{article_id}/info/',
            headers={
                'User-Agent': _TOUTIAO_MOBILE_UA,
                'Referer': 'https://m.toutiao.com/',
            },
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        data = resp.json().get('data', {})
        title = data.get('title', '')
        content_html = data.get('content', '')
        if not content_html:
            abstract = data.get('abstract', '')
            if abstract:
                content_html = f'<p>{abstract}</p>'
            else:
                return None
        content_html = re.sub(r'<script[^>]*>.*?</script>', '', content_html, flags=re.DOTALL)
        plain_text = re.sub(r'<[^>]+>', '', content_html).strip()
        if len(plain_text) < 20:
            return None
        logger.warning(f'Toutiao API OK: {len(plain_text)} chars for id={article_id}')
        return {
            'content': content_html,
            'plainText': plain_text,
            'title': title,
        }
    except Exception as e:
        logger.warning(f'Toutiao article API failed for id={article_id}: {e}')
        return None


def _extract_title_from_trending_url(url: str) -> str:
    """Extract the topic title from a Toutiao trending URL's log_pb parameter."""
    try:
        import json as _json
        from urllib.parse import urlparse as _urlparse, parse_qs as _parse_qs, unquote as _unquote
        parsed = _urlparse(url)
        params = _parse_qs(parsed.query)
        log_pb_raw = params.get('log_pb', [''])[0]
        if log_pb_raw:
            log_pb = _json.loads(_unquote(log_pb_raw))
            title = log_pb.get('title', '')
            if title:
                return title
    except Exception:
        pass
    return ''


def _fetch_toutiao_trending(event_id: str, keyword: str = '') -> dict | None:
    """Fetch the main article from a Toutiao trending event.

    Trending URLs (/trending/{event_id}) are event aggregation pages, not articles.
    Strategy: search on Toutiao mobile for the topic keyword, extract article IDs from
    the search results HTML, then fetch via mobile API.
    """
    if not keyword:
        logger.warning(f'Toutiao trending: no keyword for event {event_id}, cannot search')
        return None

    # Search on Toutiao mobile — the search results page embeds group_ids in HTML
    try:
        resp = requests.get(
            'https://m.toutiao.com/search/',
            params={'keyword': keyword, 'source': 'input'},
            headers={
                'User-Agent': _TOUTIAO_MOBILE_UA,
                'Referer': 'https://m.toutiao.com/',
            },
            timeout=12,
        )
        if resp.status_code != 200:
            logger.warning(f'Toutiao mobile search HTTP {resp.status_code} for "{keyword[:30]}"')
            return None

        # Extract IDs from the search page (group_ids and item_ids embedded in JS data)
        all_ids = re.findall(r'"group_id"\s*:\s*"?(\d{15,})"?', resp.text)
        all_ids += re.findall(r'"item_id"\s*:\s*"?(\d{15,})"?', resp.text)
        all_ids += re.findall(r'/group/(\d{15,})', resp.text)

        seen = set()
        for aid in all_ids:
            if aid in seen or aid == event_id:
                continue
            seen.add(aid)
            result = _fetch_toutiao_article_by_id(aid)
            if result:
                logger.warning(f'Toutiao trending OK via mobile search: '
                               f'event={event_id} keyword="{keyword[:20]}" → article={aid}')
                return result
            if len(seen) >= 5:
                break

    except Exception as e:
        logger.warning(f'Toutiao mobile search failed for "{keyword[:30]}": {e}')

    logger.warning(f'Toutiao trending: search found no fetchable article for event {event_id}')
    return None


def _fetch_toutiao_api(url: str, keyword: str = '') -> dict | None:
    """Fetch Toutiao article content via mobile API.
    Works for /article/{id}, /trending/{id}, /group/{id} URLs.
    For trending URLs (event aggregation pages), searches for the main article using keyword.

    Args:
        url: Toutiao URL
        keyword: Optional search keyword (topic title). If not provided, attempts to
                 extract from the URL's log_pb parameter.
    """
    # Extract ID from URL: /article/123, /trending/123, /group/123, /a123, /i123
    is_trending = '/trending/' in url
    m = re.search(r'/(?:article|trending|group)/(\d{10,})', url)
    if not m:
        m = re.search(r'/[ai](\d{10,})', url)
    if not m:
        return None
    the_id = m.group(1)

    # For trending URLs, use search-based approach
    if is_trending:
        # Try mobile API first (trending ID might also be a valid article ID in rare cases)
        result = _fetch_toutiao_article_by_id(the_id)
        if result:
            return result
        # Get keyword from parameter or from URL's log_pb
        kw = keyword or _extract_title_from_trending_url(url)
        return _fetch_toutiao_trending(the_id, keyword=kw)

    # For regular article/group URLs, use mobile API directly
    return _fetch_toutiao_article_by_id(the_id)


# ── wallstreetcn API fetcher ──────────────────────────────────────────

def _fetch_wallstreetcn_api(url: str, keyword: str = '') -> dict | None:
    """Fetch wallstreetcn article/livenews via public wscn API.
    URL formats: wallstreetcn.com/articles/{id}, wallstreetcn.com/livenews/{id}
    API: api-one-wscn.awtmt.com/apiv1/content/articles/{id}?extract=0
    """
    # Extract article ID from URL
    m = re.search(r'wallstreetcn\.com/(?:articles|livenews)/(\d+)', url)
    if not m:
        return None
    article_id = m.group(1)
    is_live = '/livenews/' in url

    try:
        if is_live:
            # Try lives endpoint for livenews
            api_url = f'https://api-one-wscn.awtmt.com/apiv1/content/lives/{article_id}'
        else:
            api_url = f'https://api-one-wscn.awtmt.com/apiv1/content/articles/{article_id}?extract=0'

        resp = requests.get(
            api_url,
            headers={'User-Agent': _UA},
            timeout=10,
            proxies=_NO_PROXY,
        )
        if resp.status_code != 200:
            # Livenews ID might also work as article
            if is_live:
                resp = requests.get(
                    f'https://api-one-wscn.awtmt.com/apiv1/content/articles/{article_id}?extract=0',
                    headers={'User-Agent': _UA},
                    timeout=10,
                    proxies=_NO_PROXY,
                )
                if resp.status_code != 200:
                    logger.warning(f'Wallstreetcn API HTTP {resp.status_code} for id={article_id}')
                    return None
            else:
                logger.warning(f'Wallstreetcn API HTTP {resp.status_code} for id={article_id}')
                return None

        data = resp.json().get('data', {})
        if not data:
            return None

        title = data.get('title', '')
        content_html = data.get('content', '')
        content_text = data.get('content_text', '')

        if not content_html and not content_text:
            return None

        # Clean HTML
        if content_html:
            content_html = re.sub(r'<script[^>]*>.*?</script>', '', content_html, flags=re.DOTALL)
        if not content_text and content_html:
            content_text = re.sub(r'<[^>]+>', '', content_html).strip()

        if len(content_text or '') < 10:
            return None

        logger.warning(f'Wallstreetcn API OK: {len(content_text)} chars for id={article_id}')
        return {
            'content': content_html or f'<p>{content_text}</p>',
            'plainText': content_text,
            'title': title,
        }
    except Exception as e:
        logger.warning(f'Wallstreetcn API failed for id={article_id}: {e}')
        return None


# ── cankaoxiaoxi (ckxx.net) content extractor ────────────────────────

def _fetch_ckxx_content(url: str, keyword: str = '') -> dict | None:
    """Extract cankaoxiaoxi article from ckxxapp.ckxx.net pages.
    Content is embedded in a JS variable: var contentTxt = "...HTML...";
    """
    try:
        resp = requests.get(
            url,
            headers={
                'User-Agent': _UA,
                'Accept-Language': 'zh-CN,zh;q=0.9',
            },
            timeout=_TIMEOUT,
            proxies=_NO_PROXY,
            verify=False,
        )
        if resp.status_code != 200:
            logger.warning(f'CKXX fetch HTTP {resp.status_code}: {url[:60]}')
            return None

        if resp.apparent_encoding:
            resp.encoding = resp.apparent_encoding

        html = resp.text

        # Extract title from <title> tag
        title_m = re.search(r'<title>(.*?)</title>', html)
        title = title_m.group(1).strip() if title_m else ''
        # Clean title suffix
        title = re.sub(r'\s*[-_|]\s*参考消息网.*$', '', title)

        # Extract content from: var contentTxt = "...";
        content_m = re.search(r'var\s+contentTxt\s*=\s*"(.*?)"\s*;', html, re.DOTALL)
        if not content_m:
            logger.warning(f'CKXX no contentTxt found: {url[:60]}')
            return None

        raw = content_m.group(1)
        # Unescape JS string
        content_html = raw.replace('\\"', '"').replace('\\/', '/').replace('\\n', '\n').replace('\\t', '')
        # Strip scripts
        content_html = re.sub(r'<script[^>]*>.*?</script>', '', content_html, flags=re.DOTALL)
        plain_text = re.sub(r'<[^>]+>', '', content_html).strip()

        if len(plain_text) < 30:
            logger.warning(f'CKXX content too short ({len(plain_text)} chars): {url[:60]}')
            return None

        logger.warning(f'CKXX contentTxt OK: {len(plain_text)} chars from {url[:60]}')
        return {
            'content': content_html,
            'plainText': plain_text,
            'title': title,
        }
    except Exception as e:
        logger.warning(f'CKXX fetch failed: {e} — {url[:60]}')
        return None


def _fetch_nfra_pdf(url: str, **kwargs) -> dict | None:
    """Fetch NFRA article content via PDF download.
    NFRA detail pages are JS SPA (Angular) but each article has a PDF at
    /chinese/OFFICE/PDF/{docId}.pdf which contains the full text."""
    import re as _re
    m = _re.search(r'docId=(\d+)', url)
    if not m:
        return None
    doc_id = m.group(1)
    pdf_url = f'https://www.nfra.gov.cn/chinese/OFFICE/PDF/{doc_id}.pdf'
    try:
        resp = requests.get(pdf_url, headers={'User-Agent': _UA}, timeout=15,
                            proxies=_NO_PROXY, verify=False)
        if resp.status_code != 200 or len(resp.content) < 500:
            return None
        import io
        import pdfplumber
        text_parts = []
        with pdfplumber.open(io.BytesIO(resp.content)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
        if not text_parts:
            return None
        full_text = '\n\n'.join(text_parts)
        # Convert plain text to HTML paragraphs
        paragraphs = [p.strip() for p in full_text.split('\n') if p.strip()]
        html_content = ''.join(f'<p>{p}</p>' for p in paragraphs)
        # Extract title from first non-empty paragraph
        title = paragraphs[0] if paragraphs else ''
        return {
            'title': title,
            'content': html_content,
            'plainText': full_text,
            'source': '国家金融监督管理总局',
            'source_url': url,
            'pdf_url': pdf_url,
        }
    except Exception as e:
        logger.warning(f'NFRA PDF fetch failed: {e} — docId={doc_id}')
        return None


# Domain → API-based fetcher mapping (these domains are NOT in _JS_SPA_DOMAINS)
_API_FETCHERS: dict[str, callable] = {
    'bilibili.com': _fetch_bilibili_api,
    'toutiao.com': _fetch_toutiao_api,
    'wallstreetcn.com': _fetch_wallstreetcn_api,
    'ckxx.net': _fetch_ckxx_content,
    'nfra.gov.cn': _fetch_nfra_pdf,
}


def _fetch_thepaper_nextdata(url: str) -> dict | None:
    """Extract thepaper.cn article from __NEXT_DATA__ JSON (perfectly clean, zero noise)."""
    try:
        resp = requests.get(url, headers={'User-Agent': _UA, 'Accept-Language': 'zh-CN,zh;q=0.9'},
                            timeout=_TIMEOUT, proxies=_NO_PROXY, verify=False)
        if resp.status_code != 200:
            return None
        if resp.apparent_encoding:
            resp.encoding = resp.apparent_encoding
        soup = BeautifulSoup(resp.text, 'html.parser')
        script = soup.find('script', id='__NEXT_DATA__')
        if not script or not script.string:
            return None
        import json as _json
        data = _json.loads(script.string)
        detail = data.get('props', {}).get('pageProps', {}).get('detailData', {}).get('contentDetail', {})
        content_html = detail.get('content', '')
        title = detail.get('name', '') or _extract_title(soup)
        if not content_html:
            return None
        # Strip scripts from content
        content_html = re.sub(r'<script[^>]*>.*?</script>', '', content_html, flags=re.DOTALL)
        plain_text = re.sub(r'<[^>]+>', '', content_html).strip()
        if len(plain_text) < 30:
            return None
        logger.warning(f'ThePaper __NEXT_DATA__ OK: {len(plain_text)} chars from {url[:60]}')
        return {'content': content_html, 'plainText': plain_text, 'title': title}
    except Exception as e:
        logger.warning(f'ThePaper __NEXT_DATA__ failed: {e}')
        return None


def _fetch_cnstock_nextdata(url: str) -> dict | None:
    """Extract cnstock.com (上海证券报) article from __NEXT_DATA__ JSON."""
    try:
        resp = requests.get(url, headers={'User-Agent': _UA, 'Accept-Language': 'zh-CN,zh;q=0.9'},
                            timeout=_TIMEOUT, proxies=_NO_PROXY, verify=False)
        if resp.status_code != 200:
            return None
        if resp.apparent_encoding:
            resp.encoding = resp.apparent_encoding
        soup = BeautifulSoup(resp.text, 'html.parser')
        script = soup.find('script', id='__NEXT_DATA__')
        if not script or not script.string:
            return None
        import json as _json
        data = _json.loads(script.string)
        detail = data.get('props', {}).get('pageProps', {}).get('data', {})
        title = detail.get('title', '') or detail.get('name', '') or _extract_title(soup)
        text_info = detail.get('textInfo', {})
        content_html = text_info.get('content', '') if isinstance(text_info, dict) else ''
        if not content_html:
            return None
        # Strip wrapping <body> tag if present
        content_html = re.sub(r'^\s*<body>\s*', '', content_html)
        content_html = re.sub(r'\s*</body>\s*$', '', content_html)
        content_html = re.sub(r'<script[^>]*>.*?</script>', '', content_html, flags=re.DOTALL)
        plain_text = re.sub(r'<[^>]+>', '', content_html).strip()
        if len(plain_text) < 30:
            return None
        logger.warning(f'cnstock __NEXT_DATA__ OK: {len(plain_text)} chars from {url[:60]}')
        return {'content': content_html, 'plainText': plain_text, 'title': title}
    except Exception as e:
        logger.warning(f'cnstock __NEXT_DATA__ failed: {e}')
        return None


def _fetch_with_playwright(url: str) -> dict | None:
    """Fetch article using Playwright headless browser (bypasses WAF like Akamai).

    Used for domains in _WAF_DOMAINS that block Python requests.
    Playwright launches real Chromium so TLS fingerprint matches a real browser.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning('Playwright not installed, cannot fetch WAF-protected URL')
        return None

    try:
        # Use proxy for domains that need it (international sites)
        domain = _get_domain(url)
        needs_proxy = any(domain.endswith(pd) for pd in _PROXY_DOMAINS)
        launch_opts = {'headless': True}
        if needs_proxy:
            launch_opts['proxy'] = {'server': 'http://127.0.0.1:17890'}

        with sync_playwright() as p:
            browser = p.chromium.launch(**launch_opts)
            page = browser.new_page()
            try:
                resp = page.goto(url, timeout=20000, wait_until='domcontentloaded')
                if not resp or resp.status != 200:
                    logger.warning(f'Playwright HTTP {resp.status if resp else "?"}: {url[:80]}')
                    return None

                # Wait briefly for JS rendering
                page.wait_for_timeout(1500)

                html = page.content()
                title = page.title() or ''

                # Detect soft-404 (HTTP 200 but page content shows "not found")
                if '404' in title.lower() or 'not found' in title.lower():
                    logger.warning(f'Playwright soft-404 (title={title[:50]}): {url[:80]}')
                    return None
            finally:
                browser.close()

        if not html or len(html) < 500:
            return None

        soup = BeautifulSoup(html, 'html.parser')
        if not title:
            title = _extract_title(soup)

        content_el = _find_content(soup, url)
        if not content_el:
            return None

        _strip_noise_elements(content_el)
        _fix_image_urls(content_el, url)
        _strip_footer_content(content_el)
        content_html = _clean_html(content_el)
        plain_text = _to_plain_text(content_el)

        if len(plain_text) < 30:
            return None

        logger.warning(f'Playwright OK: {len(plain_text)} chars from {url[:80]}')
        return {'content': str(content_html), 'plainText': plain_text, 'title': title}
    except Exception as e:
        logger.warning(f'Playwright error: {e} — {url[:80]}')
        return None


def fetch_article(url: str, use_proxy: bool = False, keyword: str = '') -> dict | None:
    """Fetch and extract article content from a URL.

    Args:
        url: The article URL to fetch.
        use_proxy: Whether to use HTTP proxy (for international sites).
        keyword: Optional search keyword for trending/topic pages (e.g. Toutiao trending).

    Returns: {'content': '<html>', 'plainText': 'text', 'title': '...'} or None
    """
    if not url:
        return None

    # Try API-based fetchers first (bilibili view API, toutiao mobile API)
    domain = _get_domain(url)
    for d, fetcher in _API_FETCHERS.items():
        if domain == d or domain.endswith('.' + d):
            try:
                # Pass keyword for search-based fetching (toutiao trending, bilibili search)
                if keyword:
                    result = fetcher(url, keyword=keyword)
                else:
                    result = fetcher(url)
                if result:
                    return result
            except Exception as e:
                logger.warning(f'API fetcher failed for {d}: {e}')
            return None  # Don't fall through to HTML scraping for API domains

    # Skip known JS-SPA domains (waste of time to try)
    if not can_fetch(url):
        logger.warning(f'Skipped JS-SPA domain: {url[:80]}')
        return None

    # Special handler: thepaper.cn — extract from __NEXT_DATA__ JSON (zero noise)
    if 'thepaper.cn' in domain:
        result = _fetch_thepaper_nextdata(url)
        if result:
            return result
        # Fall through to HTML scraping if JSON extraction fails

    # Special handler: cnstock.com (上海证券报) — Next.js SSR, extract from __NEXT_DATA__
    if 'cnstock.com' in domain:
        result = _fetch_cnstock_nextdata(url)
        if result:
            return result
        # Fall through to HTML scraping if JSON extraction fails

    # WAF-protected domains (Akamai/Cloudflare) — use Playwright headless browser
    for wd in _WAF_DOMAINS:
        if domain.endswith(wd):
            return _fetch_with_playwright(url)

    # Auto-detect proxy need
    domain = _get_domain(url)
    needs_proxy = use_proxy
    for pd in _PROXY_DOMAINS:
        if domain.endswith(pd):
            needs_proxy = True
            break

    proxies = _WITH_PROXY if needs_proxy else _NO_PROXY

    # Encode non-ASCII chars in URL (proxy latin-1 encoding fails on Chinese URLs)
    from urllib.parse import quote, urlsplit, urlunsplit
    _parts = urlsplit(url)
    url = urlunsplit((_parts.scheme, _parts.netloc,
                      quote(_parts.path, safe='/:@!$&\'()*+,;=-._~'),
                      quote(_parts.query, safe='/:@!$&\'()*+,;=-._~?'),
                      _parts.fragment))

    try:
        resp = requests.get(
            url,
            headers={
                'User-Agent': _UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': url,
            },
            timeout=_TIMEOUT,
            proxies=proxies,
            verify=False,
            allow_redirects=True,
        )
        if resp.status_code != 200:
            logger.warning(f'Article fetch HTTP {resp.status_code}: {url[:80]}')
            return None

        # Detect SPA redirect: article URL redirected to a generic homepage
        if resp.history and resp.url != url:
            final = resp.url
            # Only treat as SPA redirect if redirected to a DIFFERENT path
            # (not just http→https upgrade which keeps the same path)
            from urllib.parse import urlsplit as _us
            orig_path = _us(url).path.rstrip('/')
            final_path = _us(final).path.rstrip('/')
            if orig_path != final_path and (
                final_path in ('', '/', '/index.html', '/index.htm') or
                final.rstrip('/') in (
                    'http://www.stcn.com', 'https://www.stcn.com',
                    'http://www.yicai.com', 'https://www.yicai.com',
                )
            ):
                logger.warning(f'SPA redirect detected: {url[:60]} → {final[:60]}')
                return None

        # Auto-detect encoding
        if resp.apparent_encoding:
            resp.encoding = resp.apparent_encoding
        elif '.gov.cn' in url or '.com.cn' in url:
            resp.encoding = 'utf-8'

        html = resp.text
        if not html or len(html) < 200:
            return None

        soup = BeautifulSoup(html, 'html.parser')

        # Detect JS redirect (e.g. audit.gov.cn shell pages with full CMS template)
        _js_redir = re.search(r'window\.location\.href\s*=\s*["\']([^"\']+)', html)
        if _js_redir:
            redirect_url = _js_redir.group(1).strip()
            if redirect_url.startswith('http') and redirect_url != url:
                # Verify it's a shell page: little visible text content
                body = soup.find('body')
                body_text = body.get_text(strip=True) if body else ''
                if len(body_text) < 500:
                    logger.warning(f'JS redirect detected (shell page) → {redirect_url[:80]}')
                    return fetch_article(redirect_url, use_proxy=use_proxy, keyword=keyword)

        # CCTV/CNTV: article body is in JS variable `var contentdate = '...'`
        if 'cctv.com' in domain or 'cntv.cn' in domain:
            m = re.search(r"var\s+contentdate\s*=\s*'(.*?)'", html, re.DOTALL)
            if m:
                raw = m.group(1)
                # Strip video placeholders
                raw = re.sub(r'\[!--begin:htmlVideoCode--\].*?\[!--end:htmlVideoCode--\]', '', raw)
                body_soup = BeautifulSoup(raw, 'html.parser')
                plain = body_soup.get_text('\n', strip=True)
                if len(plain) > 30:
                    title = _extract_title(soup)
                    logger.warning(f'CCTV contentdate OK: {len(plain)} chars from {url[:80]}')
                    return {'content': raw, 'plainText': plain, 'title': title}

        # Extract title
        title = _extract_title(soup)

        # Find content element
        content_el = _find_content(soup, url)

        if not content_el:
            return None

        # Clean and extract
        _strip_noise_elements(content_el)
        _fix_image_urls(content_el, url)
        _strip_footer_content(content_el)
        content_html = _clean_html(content_el)
        plain_text = _to_plain_text(content_el)

        min_len = 20 if '.gov.cn' in url else 30
        if len(plain_text) < min_len:
            return None

        logger.warning(f'Article OK: {len(plain_text)} chars from {url[:80]}')
        return {
            'content': str(content_html),
            'plainText': plain_text,
            'title': title,
        }

    except requests.Timeout:
        logger.warning(f'Article timeout: {url[:80]}')
        return None
    except Exception as e:
        logger.warning(f'Article error ({type(e).__name__}): {e} — {url[:80]}')
        return None


def _extract_title(soup) -> str:
    """Extract page title, preferring og:title > h1 > <title>."""
    og = soup.find('meta', property='og:title')
    if og and og.get('content'):
        return og['content'].strip()
    h1 = soup.find('h1')
    if h1:
        t = h1.get_text(strip=True)
        if t:
            return t
    title_el = soup.find('title')
    if title_el:
        return title_el.get_text(strip=True)
    return ''


def _find_content(soup, url: str):
    """Find article content element using domain-specific or generic selectors."""
    domain = _get_domain(url)
    is_gov = domain.endswith('.gov.cn')

    # 1) Try domain-specific selectors
    selectors = _DOMAIN_SELECTORS.get(domain)
    if not selectors:
        # Try parent domain (e.g. paper.people.com.cn → people.com.cn)
        parts = domain.split('.')
        if len(parts) > 2:
            # Handle compound TLDs: .com.cn, .gov.cn, .co.kr, .com.au, etc.
            compound_tlds = {'cn', 'kr', 'uk', 'au', 'jp', 'br', 'in'}
            if parts[-1] in compound_tlds and len(parts) > 3:
                parent = '.'.join(parts[-3:])
            else:
                parent = '.'.join(parts[-2:])
            selectors = _DOMAIN_SELECTORS.get(parent)

    # gov.cn pages often have short notices — use lower thresholds
    domain_min = 30 if is_gov else 50
    generic_min = 50 if is_gov else 80

    if selectors:
        for sel in selectors:
            el = soup.select_one(sel)
            if el and len(el.get_text(strip=True)) > domain_min:
                # Validate: check it's not a footer/nav area
                if not _looks_like_footer(el):
                    return el

    # 2) Generic selectors (ordered by specificity)
    for sel in _GENERIC_SELECTORS:
        el = soup.select_one(sel)
        if el and len(el.get_text(strip=True)) > generic_min:
            if not _looks_like_footer(el):
                return el

    # 3) Fallback: largest text block
    return _find_largest_text_block(soup)


def _looks_like_footer(el) -> bool:
    """Check if element looks like a page footer/navigation, not article content.
    Detects: (1) ICP/copyright indicators, (2) high link density (nav lists)."""
    if not isinstance(el, Tag):
        return False
    # Check 1: Link density — navigation sections have many links relative to text
    link_count = len(el.find_all('a'))
    text_len = len(el.get_text(strip=True))
    if link_count > 30:
        return True  # 30+ links is definitely navigation/footer
    if text_len > 0 and link_count > 10 and link_count / (text_len / 100) > 5:
        return True  # >5 links per 100 chars = navigation-heavy

    # Check 2: Footer keyword indicators
    text = el.get_text(strip=True)[:500]
    footer_indicators = [
        '京ICP备', '京公网安备', '网站识别码', '版权所有', '主办单位',
        '政府网站年度报表', '行业相关网站', '联系我们', '法律声明',
        '归档数据', 'ICP证', '网安备',
    ]
    hit_count = sum(1 for ind in footer_indicators if ind in text)
    # If 3+ footer indicators in first 500 chars, it's likely footer
    # (gov.cn content areas often contain "主办单位" metadata — 2 is too aggressive)
    return hit_count >= 3


def _get_domain(url: str) -> str:
    """Extract domain from URL, keeping subdomains for known sites."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ''
        if host.startswith('www.'):
            host = host[4:]
        return host.lower()
    except Exception:
        return ''


# Generic selectors tried after domain-specific ones fail
_GENERIC_SELECTORS = [
    'div.TRS_Editor',
    'div#UCAP-CONTENT',
    'div.article-content',
    'div.article_content',
    'div.article-body',
    'div#zoom',
    'div.pages_content',
    'div.con_neirong',
    'div.rm_txt_con',
    'article.article',
    'div.detail-content',
    'div.rich_media_content',
    'div.post-content',
    'div.entry-content',
    'div.markdown-body',
    'div.content-body',
    'main article',
]


def _find_largest_text_block(soup):
    """Find the div/section with the most paragraph text content."""
    best = None
    best_score = 0
    for el in soup.find_all(['div', 'section', 'article']):
        paragraphs = el.find_all('p', recursive=True)
        if len(paragraphs) < 2:
            continue
        total_text = sum(len(p.get_text(strip=True)) for p in paragraphs)
        # Penalize elements that are too large (likely page-level containers)
        child_divs = len(el.find_all('div', recursive=False))
        if child_divs > 15:
            total_text //= 3
        # Penalize if looks like footer
        if _looks_like_footer(el):
            total_text //= 10
        # Penalize elements with nav/header elements (page-level container with chrome)
        if el.find('nav') or el.find('header') or el.find('footer'):
            total_text //= 5
        # Penalize if it contains common nav text patterns
        el_text = el.get_text(strip=True)[:200]
        if any(kw in el_text for kw in ['下载APP', '东方财富APP', '首页', '登录注册', '客户端']):
            total_text //= 5
        if total_text > best_score:
            best_score = total_text
            best = el
    if best and best_score > 100:
        return best
    return None


def _strip_noise_elements(el):
    """Remove noise elements (share widgets, nav, ads, forms, etc.) from content."""
    if not isinstance(el, Tag):
        return
    # Remove by selector
    for sel in _NOISE_SELECTORS:
        try:
            for noise in el.select(sel):
                noise.decompose()
        except Exception:
            pass

    # Remove elements by text content patterns
    for tag in el.find_all(['div', 'span', 'p', 'a']):
        text = tag.get_text(strip=True)
        if not text:
            continue
        # Share buttons text
        if re.search(r'分享到\s*[:：]?\s*(微信|微博|QQ)', text) and len(text) < 60:
            tag.decompose()
            continue
        # Font size controls — all variants:
        # "字体: 大 中 小", "字号: 大中小", "大 中 小", "【大中小】", "中 小", "Aa"
        if re.match(r'^(字体|字号|Aa)\s*[:：]?\s*(小|中|大|超大|Aa)?\s*(小|中|大)?$', text):
            tag.decompose()
            continue
        if re.match(r'^\s*【?[大中小\s]+】?\s*$', text) and len(text) < 15:
            tag.decompose()
            continue
        if re.match(r'^\s*A[\-\+⁺⁻]?\s*A[\-\+⁺⁻]?\s*$', text):
            tag.decompose()
            continue
        # "打印 关闭" toolbar
        if re.match(r'^(打印本页|打印|关闭窗口|关闭|纠错|收藏)\s*$', text):
            tag.decompose()
            continue
        # Standalone breadcrumb
        if re.match(r'^首页\s*[>›»/]', text) and len(text) < 80:
            tag.decompose()
            continue
        # ICP/copyright lines
        if re.search(r'(京ICP[备证]|京公网安备|网站识别码|政府网站年度报表)', text) and len(text) < 200:
            tag.decompose()
            continue
        # Source attribution line: "来源：XXX" or "文章来源：XXX  发布时间：..."
        if re.match(r'^(文章)?来源\s*[:：]', text) and len(text) < 80:
            tag.decompose()
            continue
        # Editor credit line: "(责编：XXX、YYY)" or "【责任编辑：XXX】" or standalone "责编：XXX"
        if re.match(r'^[【\(]?(责编|责任编辑)\s*[:：]\s*.{1,30}[】\)]?\s*$', text):
            tag.decompose()
            continue
        # "扫一扫在手机打开" etc.
        if re.search(r'扫一扫在手机', text) and len(text) < 40:
            tag.decompose()
            continue
        # People.com.cn toolbar: "订阅/取消订阅/收藏/大字号/点击播报"
        if re.match(r'^(订阅|取消订阅|已收藏|大字号|小字号)\s*$', text):
            tag.decompose()
            continue
        # Page navigation: 【TOP】【打印页面】【关闭页面】
        if re.match(r'^\s*【\s*(TOP|打印页面|关闭页面)\s*】', text) and len(text) < 40:
            tag.decompose()
            continue
        if re.match(r'^点击播报本文', text) and len(text) < 30:
            tag.decompose()
            continue

    # Remove Sina finance promo links ("登录新浪财经APP 搜索【信披】...")
    for tag in el.find_all('a'):
        text = tag.get_text(strip=True)
        if re.search(r'登录.*APP.*搜索|信披.*考评等级', text) and len(text) < 100:
            # Remove the parent <p> or <div> if it only contains this link
            parent = tag.parent
            tag.decompose()
            if parent and parent.name in ('p', 'div') and not parent.get_text(strip=True):
                parent.decompose()
            continue

    # Remove app-download promo blocks (QR code image + "尽在XXX APP" text)
    _app_promo_re = re.compile(r'(海量资讯|尽在.*APP|下载.*客户端|扫码下载|扫描.*二维码|关注.*公众号|微信公众号|扫码免费获取|扫码进群)')
    for tag in el.find_all(['div', 'section', 'p']):
        text = tag.get_text(strip=True)
        if _app_promo_re.search(text) and len(text) < 200:
            tag.decompose()
            continue

    # International site noise (Fed, ECB, etc.) — HTML-level removal
    # Remove ShareThis sharing containers (IMF etc.): <div role="list"> containing sharing listitem
    for tag in el.find_all(attrs={'role': 'list'}):
        if tag.find(attrs={'aria-label': re.compile(r'sharing')}):
            tag.decompose()
    # Remove share buttons with role="button" or role="menu"
    for tag in el.find_all(attrs={'role': 'menu'}):
        tag.decompose()
    for tag in el.find_all('a', attrs={'role': 'button', 'title': 'Share'}):
        # Also remove parent <li> if it only contains the share link
        parent = tag.parent
        tag.decompose()
        if parent and parent.name == 'li' and not parent.get_text(strip=True):
            parent.decompose()
    # Remove "Related Content" / "延伸阅读" heading blocks and their parent containers
    _trailing_section_labels = {
        'Related Content', 'Related Information', 'Related Links',
        '延伸阅读', '相关阅读', '热点视频', '热门文章', '推荐阅读',
        '热点关注', '相关新闻', '猜你喜欢',
    }
    for tag in el.find_all(['h5', 'h4', 'h3', 'h2', 'strong', 'b']):
        text = tag.get_text(strip=True)
        if text in _trailing_section_labels:
            # Remove the heading's parent container (the whole related section)
            parent = tag.parent
            if parent and parent.name == 'div':
                grandparent = parent.parent
                if grandparent and grandparent.name == 'div':
                    grandparent.decompose()
                else:
                    parent.decompose()
            else:
                tag.decompose()
    for tag in el.find_all('p'):
        text = tag.get_text(strip=True)
        if re.search(r'For media inquiries.*\d{3}-\d{3}-\d{4}', text):
            tag.decompose()
            continue
        if re.match(r'^\s*For release at\b', text):
            tag.decompose()
            continue
    # Remove PDF download links (e.g., "Order (PDF)")
    for tag in el.find_all('a'):
        text = tag.get_text(strip=True)
        if re.match(r'^.{3,30}\s*\(PDF\)\s*$', text):
            parent = tag.parent
            tag.decompose()
            # Clean up empty parent li/div
            if parent and parent.name in ('li', 'div') and not parent.get_text(strip=True):
                parent.decompose()

    # ── Navigation <ul> lists that leak into article area ──
    # A <ul> with many short link-only <li> items is almost certainly channel navigation.
    # Pattern: ≥4 <li> items, each is a short (<15 char) link with no paragraph text.
    for ul in el.find_all('ul'):
        lis = ul.find_all('li', recursive=False)
        if len(lis) < 4:
            continue
        nav_count = 0
        for li in lis:
            text = li.get_text(strip=True)
            # Short text + contains a link → navigation item
            if len(text) < 15 and li.find('a'):
                nav_count += 1
        if nav_count >= len(lis) * 0.7:   # 70%+ are nav-like → kill the <ul>
            ul.decompose()

    # ── Header/masthead blocks that leak into article area ──
    # A leading <div> with very short text, many links, and no <p> tags is likely a header.
    children = list(el.children)
    for child in children[:5]:  # Only check first 5 children (headers are at the top)
        if not isinstance(child, Tag):
            continue
        text = child.get_text(strip=True)
        if not text:
            continue
        # Skip if it has real paragraph content
        if child.find('p') and len(text) > 100:
            continue
        links = child.find_all('a')
        # Many links + short text → header/nav block
        if len(links) >= 4 and len(text) < 200:
            avg_link_len = sum(len(a.get_text(strip=True)) for a in links) / max(len(links), 1)
            if avg_link_len < 12:
                child.decompose()
                continue
        # Single-line channel header: "新浪河北 > 资讯 > 民生 > 社会 > 各地"
        if re.match(r'^(新浪|凤凰|搜狐|网易|腾讯)\S{0,6}\s*[>›»]', text) and len(text) < 80:
            child.decompose()
            continue
        # Standalone site name or short nav text at the top
        if len(text) < 20 and links and not child.find('p'):
            link_text = ' '.join(a.get_text(strip=True) for a in links)
            if link_text == text.strip():
                child.decompose()
                continue

    # Remove images that are tracking pixels
    for img in el.find_all('img'):
        w = img.get('width', '')
        h = img.get('height', '')
        if w in ('0', '1') or h in ('0', '1'):
            img.decompose()
            continue
        # Remove images that are clearly site chrome (logos, icons, QR codes)
        src = img.get('src', '') or ''
        alt = img.get('alt', '') or ''
        if any(kw in src.lower() for kw in ['logo', 'icon', 'banner', 'badge', 'qrcode', 'erweima',
                                              'qr_code', 'qr-code', 'app_download', 'appdownload']):
            img.decompose()
            continue
        if any(kw in alt for kw in ['二维码', '公众号', '扫描', '关注']):
            img.decompose()
            continue


def _fix_image_urls(el, base_url: str):
    """Convert relative image URLs to absolute using the article's base URL."""
    if not isinstance(el, Tag):
        return
    for img in el.find_all('img'):
        src = img.get('src', '')
        if not src:
            # Try data-src (lazy loading)
            src = img.get('data-src', '') or img.get('data-original', '')
            if src:
                img['src'] = src

        if src and not src.startswith(('http://', 'https://', 'data:')):
            # Convert relative to absolute
            abs_url = urljoin(base_url, src)
            img['src'] = abs_url

        # Remove srcset (can cause issues in our drawer)
        if img.get('srcset'):
            del img['srcset']


def _strip_footer_content(el):
    """Remove footer-like content that sneaked into article area.
    Detects blocks at the end of content that contain ICP/copyright info,
    QR code images, and app-download promo blocks."""
    if not isinstance(el, Tag):
        return

    # Walk children from bottom up, remove footer-ish blocks
    children = list(el.children)
    for child in reversed(children):
        if not isinstance(child, Tag):
            continue
        text = child.get_text(strip=True)
        # Remove empty trailing blocks or blocks with only an image (QR code / ad)
        if not text:
            # Check if it's just an image (likely QR code at bottom)
            if child.find('img') or child.name == 'img':
                child.decompose()
            continue
        # If this block has footer indicators, remove it
        if _looks_like_footer(child):
            child.decompose()
            continue
        # Trailing image-only blocks with very short text (e.g. "查看原文", caption)
        if len(text) < 30 and child.find('img'):
            child.decompose()
            continue
        # Trailing standalone images (direct <img> or <p><img></p>)
        if child.name == 'img':
            child.decompose()
            continue
        if child.name == 'p' and len(text) < 10 and child.find('img'):
            child.decompose()
            continue
        # Stop walking once we hit real content
        if len(text) > 100:
            break


def _clean_html(el):
    """Clean HTML for display in drawer."""
    # Remove scripts, styles, iframes, etc.
    for tag in el.find_all(['script', 'style', 'iframe', 'noscript', 'link', 'meta',
                            'select', 'form', 'input', 'textarea', 'button', 'object', 'embed']):
        tag.decompose()

    # Remove hidden elements
    for tag in el.find_all(style=re.compile(r'display\s*:\s*none', re.I)):
        tag.decompose()

    # Remove data-* and event handler attributes + clean inline styles
    for tag in el.find_all(True):
        attrs_to_remove = [k for k in tag.attrs if k.startswith('data-') or k.startswith('on')]
        for attr in attrs_to_remove:
            del tag[attr]

        # For tables: keep style but sanitize it (allow width, border, padding)
        if tag.name in ('table', 'th', 'td', 'tr'):
            style = tag.get('style', '')
            if style:
                # Strip color/font/background that would break dark theme
                cleaned = _sanitize_table_style(style)
                if cleaned:
                    tag['style'] = cleaned
                else:
                    del tag['style']
            # Remove class/id
            for attr in ['class', 'id']:
                if attr in tag.attrs:
                    del tag[attr]
        elif tag.name in ('img', 'a', 'video'):
            # Keep href/src but remove style/class/id
            for attr in ['class', 'id', 'style']:
                if attr in tag.attrs:
                    del tag[attr]
        else:
            # Remove all class/id/style from text elements
            for attr in ['class', 'id', 'style']:
                if attr in tag.attrs:
                    del tag[attr]

    # Convert <pre> to <p> (pre causes scrollbars / no-wrap in drawer)
    for pre in el.find_all('pre'):
        pre.name = 'p'

    # Final pass: remove short noise-only elements (font controls, toolbar text, etc.)
    _html_noise_re = re.compile(
        r'^\s*('
        r'【?[大中小\s]+】?'           # 大 中 小 / 【大中小】
        r'|字[体号]\s*[:：]?\s*[大中小Aa\s]*'  # 字体: 大中小
        r'|A[\-\+⁺⁻]?\s*A[\-\+⁺⁻]?'  # A+A- font controls
        r'|打印本?页?|关闭窗?口?|纠错|收藏'
        r'|分享到?\s*[:：]?'
        r'|订阅|取消订阅|已收藏|大字号|小字号'
        r')\s*$'
    )
    for tag in el.find_all(['div', 'span', 'p', 'a', 'li']):
        text = tag.get_text(strip=True)
        if text and len(text) < 20 and _html_noise_re.match(text):
            tag.decompose()
            continue

    # Remove empty elements (but keep img, table, br, hr)
    for tag in el.find_all(['div', 'span', 'p', 'a']):
        if not tag.get_text(strip=True) and not tag.find(['img', 'table', 'video']):
            tag.decompose()

    # Dedup: remove repeated paragraph elements (photo captions in xinhua/people)
    seen_texts = set()
    for tag in el.find_all('p'):
        text = tag.get_text(strip=True)
        if len(text) > 30 and text in seen_texts:
            tag.decompose()
            continue
        if text:
            seen_texts.add(text)

    return el


def _sanitize_table_style(style: str) -> str:
    """Keep only safe table CSS properties (width, border, padding, text-align)."""
    safe_props = []
    for part in style.split(';'):
        part = part.strip()
        if not part:
            continue
        prop_name = part.split(':')[0].strip().lower()
        if prop_name in ('width', 'min-width', 'max-width', 'border', 'border-collapse',
                         'padding', 'text-align', 'vertical-align', 'white-space'):
            safe_props.append(part)
    return '; '.join(safe_props)


def _to_plain_text(el) -> str:
    """Extract clean plain text, stripping noise patterns."""
    text = el.get_text(separator='\n', strip=True)
    # Apply noise text patterns
    for pattern in _NOISE_RE:
        text = pattern.sub('', text)
    # Normalize whitespace
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Remove lines that are just punctuation or very short noise
    lines = []
    seen_lines = set()
    for line in text.split('\n'):
        line = line.strip()
        if not line:
            lines.append('')
            continue
        if len(line) < 4 and re.match(r'^[|/·\-–—【】\[\]\s]+$', line):
            continue
        # Dedup: skip repeated paragraphs (photo captions in xinhua/people articles)
        if len(line) > 30 and line in seen_lines:
            continue
        seen_lines.add(line)
        lines.append(line)
    return '\n'.join(lines).strip()
