"""Global Data Feeds — aggregate international data from relay service.

Fetches 3 types of international data:
  1. RSS international news — 395 sources across 24 categories:
     Wire Services | US Finance | US Government | UK/Europe English | Europe Local Language
     Asia-Pacific | Middle East | Africa | Latin America | Russia/Ukraine
     Tech/AI | Startups/VC | Regional Startups | Think Tanks/Policy
     Energy/Commodities | Crypto/Fintech | Central Banks/Economics
     Financial Markets Deep | Defense/Security | Crisis/Intl Orgs
     Science/Innovation | Developer/Open Source | Positive News | Other
  2. Yahoo Finance global indices (S&P 500, Nasdaq, VIX, Gold, Oil, USDCNY)
  3. Polymarket prediction markets (china, trade, fed, economy, ai tags)

Mirrors ALL feed URLs from the main worldmonitor frontend (src/config/feeds.ts).
Uses Google News RSS proxy for sources not in relay allowlist.
All RSS fetched in parallel via ThreadPoolExecutor (20 workers, 45s deadline).
Uses thread-safe caching with stale fallback, same pattern as global_signals.py.
"""

import json
import logging
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import requests

from config import Config
from services.cache import cache_get, cache_set

logger = logging.getLogger('cn-intel.global-feeds')

# ── RSS Feed Sources ────────────────────────────────────────────────────────

RSS_FEEDS = [
    # ── Wire Services (9) ────────────────────────────────────────
    ('https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en', 'AP News'),
    ('https://news.google.com/rss/search?q=site:reuters.com+world&hl=en-US&gl=US&ceid=US:en', 'Reuters World'),
    ('https://news.google.com/rss/search?q=site:reuters.com+US&hl=en-US&gl=US&ceid=US:en', 'Reuters US'),
    ('https://news.google.com/rss/search?q=site:reuters.com+business+markets&hl=en-US&gl=US&ceid=US:en', 'Reuters Business'),
    ('https://news.google.com/rss/search?q=site:reuters.com+(Brazil+OR+Mexico+OR+Argentina)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Reuters LatAm'),
    ('https://news.google.com/rss/search?q=site:reuters.com+(China+OR+Japan+OR+Taiwan+OR+Korea)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Reuters Asia'),
    ('https://news.google.com/rss/search?q=site:reuters.com+(oil+OR+gas+OR+energy+OR+OPEC)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Reuters Energy'),
    ('https://news.google.com/rss/search?q=site:reuters.com+markets+stocks+when:1d&hl=en-US&gl=US&ceid=US:en', 'Reuters Markets'),
    ('https://news.google.com/rss/search?q=site:bloomberg.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en', 'Bloomberg Markets'),

    # ── US Finance & Markets (10) ─────────────────────────────────
    ('https://feeds.content.dowjones.io/public/rss/RSSUSnews', 'Wall Street Journal'),
    ('https://www.naftemporiki.gr/feed/', 'Naftemporiki'),
    ('https://www.cnbc.com/id/100003114/device/rss/rss.html', 'CNBC'),
    ('https://news.google.com/rss/search?q=site:marketwatch.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en', 'MarketWatch'),
    ('https://finance.yahoo.com/news/rssindex', 'Yahoo Finance'),
    ('https://www.ft.com/rss/home', 'Financial Times'),
    ('https://responsiblestatecraft.org/feed/', 'Responsible Statecraft'),
    ('https://sifted.eu/feed', 'Sifted (Europe)'),
    ('https://www.cnbc.com/id/19854910/device/rss/rss.html', 'CNBC Tech'),
    ('https://news.google.com/rss/search?q=site:marketwatch.com+technology+markets+when:2d&hl=en-US&gl=US&ceid=US:en', 'MarketWatch Tech'),

    # ── US Government & Institutions (15) ─────────────────────────
    ('https://news.google.com/rss/search?q=site:whitehouse.gov&hl=en-US&gl=US&ceid=US:en', 'White House'),
    ('https://news.google.com/rss/search?q=site:state.gov+OR+"State+Department"&hl=en-US&gl=US&ceid=US:en', 'State Dept'),
    ('https://news.google.com/rss/search?q=site:defense.gov+OR+Pentagon&hl=en-US&gl=US&ceid=US:en', 'Pentagon'),
    ('https://news.google.com/rss/search?q=site:treasury.gov+OR+"Treasury+Department"&hl=en-US&gl=US&ceid=US:en', 'Treasury'),
    ('https://news.google.com/rss/search?q=site:justice.gov+OR+"Justice+Department"+DOJ&hl=en-US&gl=US&ceid=US:en', 'DOJ'),
    ('https://www.federalreserve.gov/feeds/press_all.xml', 'Federal Reserve'),
    ('https://www.sec.gov/news/pressreleases.rss', 'SEC'),
    ('https://news.google.com/rss/search?q=site:cdc.gov+OR+CDC+health&hl=en-US&gl=US&ceid=US:en', 'CDC'),
    ('https://news.google.com/rss/search?q=site:fema.gov+OR+FEMA+emergency&hl=en-US&gl=US&ceid=US:en', 'FEMA'),
    ('https://news.google.com/rss/search?q=site:dhs.gov+OR+"Homeland+Security"&hl=en-US&gl=US&ceid=US:en', 'DHS'),
    ('https://www.cisa.gov/cybersecurity-advisories/all.xml', 'CISA'),
    ('https://news.google.com/rss/search?q=(Mexico+cartel+OR+Mexico+violence+OR+Mexico+troops+OR+narco+Mexico)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Mexico Security'),
    ('https://news.google.com/rss/search?q=(S-1+OR+"IPO+filing"+OR+"SEC+filing")+startup+when:7d&hl=en-US&gl=US&ceid=US:en', 'SEC Filings'),
    ('https://krebsonsecurity.com/feed/', 'Krebs Security'),
    ('https://news.google.com/rss/search?q=("US+Treasury"+OR+"Treasury+auction"+OR+"10-year+yield"+OR+"2-year+yield")+when:2d&hl=en-US&gl=US&ceid=US:en', 'Treasury Watch'),

    # ── UK & Europe English (14) ────────────────────────────────
    ('https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC World'),
    ('https://www.theguardian.com/world/rss', 'Guardian World'),
    ('https://news.google.com/rss/search?q=site:cnn.com+world+news+when:1d&hl=en-US&gl=US&ceid=US:en', 'CNN World'),
    ('https://feeds.npr.org/1001/rss.xml', 'NPR News'),
    ('https://www.pbs.org/newshour/feeds/rss/headlines', 'PBS NewsHour'),
    ('https://feeds.abcnews.com/abcnews/topstories', 'ABC News'),
    ('https://www.cbsnews.com/latest/rss/main', 'CBS News'),
    ('https://feeds.nbcnews.com/nbcnews/public/news', 'NBC News'),
    ('https://thehill.com/news/feed', 'The Hill'),
    ('https://api.axios.com/feed/', 'Axios'),
    ('https://moxie.foxnews.com/google-publisher/us.xml', 'Fox News'),
    ('https://www.bbc.com/afrique/index.xml', 'BBC Afrique'),
    ('https://www.abc.net.au/news/feed/2942460/rss.xml', 'ABC News Australia'),
    ('https://rss.dw.com/xml/rss-en-all', 'DW News'),

    # ── Europe Local Language (28) ──────────────────────────────
    ('https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada', 'El País'),
    ('https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml', 'El Mundo'),
    ('https://www.bbc.com/mundo/index.xml', 'BBC Mundo'),
    ('https://www.tagesschau.de/xml/rss2/', 'Tagesschau'),
    ('https://www.bild.de/feed/alles.xml', 'Bild'),
    ('https://www.spiegel.de/schlagzeilen/tops/index.rss', 'Der Spiegel'),
    ('https://newsfeed.zeit.de/index', 'Die Zeit'),
    ('https://www.ansa.it/sito/notizie/topnews/topnews_rss.xml', 'ANSA'),
    ('https://www.repubblica.it/rss/homepage/rss2.0.xml', 'Repubblica'),
    ('https://feeds.nos.nl/nosnieuwsalgemeen', 'NOS Nieuws'),
    ('https://www.nrc.nl/rss/', 'NRC'),
    ('https://news.google.com/rss/search?q=site:telegraaf.nl+when:1d&hl=nl&gl=NL&ceid=NL:nl', 'De Telegraaf'),
    ('https://www.svt.se/nyheter/rss.xml', 'SVT Nyheter'),
    ('https://www.dn.se/rss/', 'Dagens Nyheter'),
    ('https://www.svd.se/feed/articles.rss', 'Svenska Dagbladet'),
    ('https://feeds.bbci.co.uk/turkce/rss.xml', 'BBC Turkce'),
    ('https://rss.dw.com/xml/rss-tur-all', 'DW Turkish'),
    ('https://www.hurriyet.com.tr/rss/anasayfa', 'Hurriyet'),
    ('https://tvn24.pl/swiat.xml', 'TVN24'),
    ('https://www.polsatnews.pl/rss/wszystkie.xml', 'Polsat News'),
    ('https://www.rp.pl/rss_main', 'Rzeczpospolita'),
    ('https://news.google.com/rss/search?q=site:kathimerini.gr+when:2d&hl=el&gl=GR&ceid=GR:el', 'Kathimerini'),
    ('https://www.in.gr/feed/', 'in.gr'),
    ('https://www.iefimerida.gr/rss.xml', 'iefimerida'),
    ('https://news.google.com/rss/search?q=site:protothema.gr+when:2d&hl=el&gl=GR&ceid=GR:el', 'Proto Thema'),
    ('https://www.france24.com/en/rss', 'France 24'),
    ('https://www.euronews.com/rss?format=xml', 'EuroNews'),
    ('https://www.lemonde.fr/en/rss/une.xml', 'Le Monde'),

    # ── Asia-Pacific (20) ─────────────────────────────────────────
    ('https://news.google.com/rss/search?q=(China+OR+Japan+OR+Korea+OR+India+OR+ASEAN)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Asia News'),
    ('https://feeds.bbci.co.uk/news/world/asia/rss.xml', 'BBC Asia'),
    ('https://thediplomat.com/feed/', 'The Diplomat'),
    ('https://www.scmp.com/rss/91/feed/', 'South China Morning Post'),
    ('https://news.google.com/rss/search?q=site:xinhuanet.com+OR+Xinhua+when:1d&hl=en-US&gl=US&ceid=US:en', 'Xinhua'),
    ('https://japantoday.com/feed/atom', 'Japan Today'),
    ('https://news.google.com/rss/search?q=site:asia.nikkei.com+when:3d&hl=en-US&gl=US&ceid=US:en', 'Nikkei Asia'),
    ('https://www.asahi.com/rss/asahi/newsheadlines.rdf', 'Asahi Shimbun'),
    ('https://www.thehindu.com/news/national/feeder/default.rss', 'The Hindu'),
    ('https://indianexpress.com/section/india/feed/', 'Indian Express'),
    ('https://feeds.feedburner.com/ndtvnews-top-stories', 'NDTV'),
    ('https://news.google.com/rss/search?q=India+diplomacy+foreign+policy+news&hl=en&gl=US&ceid=US:en', 'India News Network'),
    ('https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml', 'CNA'),
    ('https://news.google.com/rss/search?q=site:miit.gov.cn+when:7d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', 'MIIT (China)'),
    ('https://news.google.com/rss/search?q=site:mofcom.gov.cn+when:7d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', 'MOFCOM (China)'),
    ('https://news.google.com/rss/search?q=site:bangkokpost.com+when:1d&hl=en-US&gl=US&ceid=US:en', 'Bangkok Post'),
    ('https://vnexpress.net/rss/tin-moi-nhat.rss', 'VnExpress'),
    ('https://www.theguardian.com/australia-news/rss', 'Guardian Australia'),
    ('https://islandtimes.org/feed/', 'Island Times (Palau)'),
    ('https://news.google.com/rss/search?q=site:cnas.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'CNAS'),

    # ── Middle East (17) ──────────────────────────────────────────
    ('https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', 'BBC Middle East'),
    ('https://www.theguardian.com/world/middleeast/rss', 'Guardian ME'),
    ('http://feeds.bbci.co.uk/persian/tv-and-radio-37434376/rss.xml', 'BBC Persian'),
    ('https://news.google.com/rss/search?q=site:iranintl.com+when:2d&hl=en-US&gl=US&ceid=US:en', 'Iran International'),
    ('https://news.google.com/rss/search?q=site:farsnews.ir+when:2d&hl=en-US&gl=US&ceid=US:en', 'Fars News'),
    ('https://news.google.com/rss/search?q=site:haaretz.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'Haaretz'),
    ('https://news.google.com/rss/search?q=site:arabnews.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'Arab News'),
    ('https://news.google.com/rss/search?q=site:thenationalnews.com+when:2d&hl=en-US&gl=US&ceid=US:en', 'The National'),
    ('https://www.omanobserver.om/rssFeed/1', 'Oman Observer'),
    ('https://asharqbusiness.com/rss.xml', 'Asharq Business'),
    ('https://asharq.com/snapchat/rss.xml', 'Asharq News'),
    ('https://news.google.com/rss/search?q=site:arabianbusiness.com+(Saudi+Arabia+OR+UAE+OR+GCC)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Arabian Business'),
    ('https://news.google.com/rss/search?q=(PIF+OR+"DP+World"+OR+Mubadala+OR+ADNOC+OR+Masdar+OR+"ACWA+Power")+infrastructure+when:7d&hl=en-US&gl=US&ceid=US:en', 'Gulf FDI'),
    ('https://news.google.com/rss/search?q=("Saudi+Arabia"+OR+"UAE"+OR+"Abu+Dhabi")+investment+infrastructure+when:7d&hl=en-US&gl=US&ceid=US:en', 'Gulf Investments'),
    ('https://news.google.com/rss/search?q="Vision+2030"+(project+OR+investment+OR+announced)+when:14d&hl=en-US&gl=US&ceid=US:en', 'Vision 2030'),
    ('https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'),
    ('https://news.google.com/rss/search?q=site:english.alarabiya.net+when:2d&hl=en-US&gl=US&ceid=US:en', 'Al Arabiya'),

    # ── Africa (11) ───────────────────────────────────────────────
    ('https://news.google.com/rss/search?q=(Africa+OR+Nigeria+OR+Kenya+OR+"South+Africa"+OR+Ethiopia)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Africa News'),
    ('https://news.google.com/rss/search?q=(Sahel+OR+Mali+OR+Niger+OR+"Burkina+Faso"+OR+Wagner)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Sahel Crisis'),
    ('https://feeds.news24.com/articles/news24/TopStories/rss', 'News24'),
    ('https://feeds.bbci.co.uk/news/world/africa/rss.xml', 'BBC Africa'),
    ('https://www.jeuneafrique.com/feed/', 'Jeune Afrique'),
    ('https://www.premiumtimesng.com/feed', 'Premium Times'),
    ('https://www.vanguardngr.com/feed/', 'Vanguard Nigeria'),
    ('https://www.channelstv.com/feed/', 'Channels TV'),
    ('https://dailytrust.com/feed/', 'Daily Trust'),
    ('https://www.thisdaylive.com/feed', 'ThisDay'),
    ('https://www.africanews.com/feed/rss', 'Africanews'),

    # ── Latin America (16) ────────────────────────────────────────
    ('https://news.google.com/rss/search?q=(Brazil+OR+Mexico+OR+Argentina+OR+Venezuela+OR+Colombia)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Latin America'),
    ('https://feeds.bbci.co.uk/news/world/latin_america/rss.xml', 'BBC Latin America'),
    ('https://www.theguardian.com/world/americas/rss', 'Guardian Americas'),
    ('https://www.clarin.com/rss/lo-ultimo/', 'Clarín'),
    ('https://news.google.com/rss/search?q=site:oglobo.globo.com+when:1d&hl=pt-BR&gl=BR&ceid=BR:pt-419', 'O Globo'),
    ('https://feeds.folha.uol.com.br/emcimadahora/rss091.xml', 'Folha de S.Paulo'),
    ('https://www.brasilparalelo.com.br/noticias/rss.xml', 'Brasil Paralelo'),
    ('https://www.eltiempo.com/rss/mundo_latinoamerica.xml', 'El Tiempo'),
    ('https://www.lasillavacia.com/rss', 'La Silla Vacía'),
    ('https://www.primicias.ec/feed/', 'Primicias'),
    ('https://www.infobae.com/feeds/rss/', 'Infobae Americas'),
    ('https://www.eluniverso.com/arc/outboundfeeds/rss/category/noticias/?outputType=xml', 'El Universo'),
    ('https://mexiconewsdaily.com/feed/', 'Mexico News Daily'),
    ('https://news.google.com/rss/search?q=site:apnews.com+Mexico+when:3d&hl=en-US&gl=US&ceid=US:en', 'AP Mexico'),
    ('https://insightcrime.org/feed/', 'InSight Crime'),
    ('https://www.france24.com/en/americas/rss', 'France 24 LatAm'),

    # ── Russia & Ukraine (6) ─────────────────────────────────────
    ('https://feeds.bbci.co.uk/russian/rss.xml', 'BBC Russian'),
    ('https://meduza.io/rss/all', 'Meduza'),
    ('https://novayagazeta.eu/feed/rss', 'Novaya Gazeta Europe'),
    ('https://news.google.com/rss/search?q=site:tass.com+OR+TASS+Russia+when:1d&hl=en-US&gl=US&ceid=US:en', 'TASS'),
    ('https://news.google.com/rss/search?q=site:kyivindependent.com+when:3d&hl=en-US&gl=US&ceid=US:en', 'Kyiv Independent'),
    ('https://www.themoscowtimes.com/rss/news', 'Moscow Times'),

    # ── Tech & AI (25) ────────────────────────────────────────────
    ('https://hnrss.org/frontpage', 'Hacker News'),
    ('https://feeds.arstechnica.com/arstechnica/technology-lab', 'Ars Technica'),
    ('https://www.theverge.com/rss/index.xml', 'The Verge'),
    ('https://www.technologyreview.com/feed/', 'MIT Tech Review'),
    ('https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+Google+AI+OR+"large+language+model"+OR+ChatGPT)+when:2d&hl=en-US&gl=US&ceid=US:en', 'AI News'),
    ('https://venturebeat.com/category/ai/feed/', 'VentureBeat AI'),
    ('https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'The Verge AI'),
    ('https://export.arxiv.org/rss/cs.AI', 'ArXiv AI'),
    ('https://news.google.com/rss/search?q=Thai+PBS+World+news&hl=en&gl=US&ceid=US:en', 'Thai PBS'),
    ('https://www.zdnet.com/news/rss.xml', 'ZDNet'),
    ('https://www.techmeme.com/feed.xml', 'TechMeme'),
    ('https://www.engadget.com/rss.xml', 'Engadget'),
    ('https://feeds.feedburner.com/fastcompany/headlines', 'Fast Company'),
    ('https://www.technologyreview.com/topic/artificial-intelligence/feed', 'MIT Tech Review AI'),
    ('https://export.arxiv.org/rss/cs.LG', 'ArXiv ML'),
    ('https://news.google.com/rss/search?q="artificial+intelligence"+OR+"machine+learning"+when:3d&hl=en-US&gl=US&ceid=US:en', 'AI Weekly'),
    ('https://news.google.com/rss/search?q=Anthropic+Claude+AI+when:7d&hl=en-US&gl=US&ceid=US:en', 'Anthropic News'),
    ('https://news.google.com/rss/search?q=OpenAI+ChatGPT+GPT-4+when:7d&hl=en-US&gl=US&ceid=US:en', 'OpenAI News'),
    ('https://venturebeat.com/feed/', 'VentureBeat'),
    ('https://feeds.feedburner.com/TheHackersNews', 'The Hacker News'),
    ('https://news.google.com/rss/search?q=site:semianalysis.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'SemiAnalysis'),
    ('https://news.google.com/rss/search?q=semiconductor+OR+chip+OR+TSMC+OR+NVIDIA+OR+Intel+when:3d&hl=en-US&gl=US&ceid=US:en', 'Semiconductor News'),
    ('https://news.google.com/rss/search?q=("Vergecast"+OR+"Decoder+podcast"+Verge)+when:14d&hl=en-US&gl=US&ceid=US:en', 'Verge Shows'),
    ('https://news.google.com/rss/search?q=("AI+podcast"+OR+"artificial+intelligence+podcast")+episode+when:14d&hl=en-US&gl=US&ceid=US:en', 'AI Podcasts'),
    ('https://news.google.com/rss/search?q=(NVIDIA+OR+OpenAI+OR+Anthropic+OR+DeepMind)+interview+OR+podcast+when:14d&hl=en-US&gl=US&ceid=US:en', 'AI Interviews'),

    # ── Startups & VC (36) ────────────────────────────────────────
    ('https://news.google.com/rss/search?q=tech+company+layoffs+announced&hl=en&gl=US&ceid=US:en', 'Layoffs.fyi'),
    ('https://techcrunch.com/tag/layoffs/feed/', 'TechCrunch Layoffs'),
    ('https://news.google.com/rss/search?q=(layoffs+OR+"job+cuts"+OR+"workforce+reduction")+when:3d&hl=en-US&gl=US&ceid=US:en', 'Layoffs News'),
    ('https://techcrunch.com/feed/', 'TechCrunch'),
    ('https://techcrunch.com/category/startups/feed/', 'TechCrunch Startups'),
    ('https://news.crunchbase.com/feed/', 'Crunchbase News'),
    ('https://www.saastr.com/feed/', 'SaaStr'),
    ('https://news.google.com/rss/search?q=site:angellist.com+OR+"AngelList"+funding+when:7d&hl=en-US&gl=US&ceid=US:en', 'AngelList News'),
    ('https://techcrunch.com/category/venture/feed/', 'TechCrunch Venture'),
    ('https://news.google.com/rss/search?q=site:theinformation.com+startup+OR+funding+when:3d&hl=en-US&gl=US&ceid=US:en', 'The Information'),
    ('https://news.google.com/rss/search?q="Term+Sheet"+venture+capital+OR+startup+when:7d&hl=en-US&gl=US&ceid=US:en', 'Fortune Term Sheet'),
    ('https://news.google.com/rss/search?q=site:pitchbook.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'PitchBook News'),
    ('https://www.cbinsights.com/research/feed/', 'CB Insights'),
    ('https://news.google.com/rss/search?q=site:a16z.com+OR+"Andreessen+Horowitz"+blog+when:14d&hl=en-US&gl=US&ceid=US:en', 'a16z Blog'),
    ('https://news.google.com/rss/search?q=site:sequoiacap.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'Sequoia Blog'),
    ('https://news.google.com/rss/search?q="Paul+Graham"+essay+OR+blog+when:30d&hl=en-US&gl=US&ceid=US:en', 'Paul Graham Essays'),
    ('https://news.google.com/rss/search?q=("venture+capital"+insights+OR+"VC+trends"+OR+"startup+advice")+when:7d&hl=en-US&gl=US&ceid=US:en', 'VC Insights'),
    ('https://news.google.com/rss/search?q=("Y+Combinator"+OR+"YC+launch"+OR+"YC+W25"+OR+"YC+S25")+when:7d&hl=en-US&gl=US&ceid=US:en', 'YC Launches'),
    ('https://news.google.com/rss/search?q=("Series+A"+OR+"Series+B"+OR+"Series+C"+OR+"funding+round"+OR+"venture+capital")+when:7d&hl=en-US&gl=US&ceid=US:en', 'VC News'),
    ('https://news.google.com/rss/search?q=("seed+round"+OR+"pre-seed"+OR+"angel+round"+OR+"seed+funding")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Seed & Pre-Seed'),
    ('https://news.google.com/rss/search?q=("startup+funding"+OR+"raised+funding"+OR+"raised+$"+OR+"funding+announced")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Startup Funding'),
    ('https://www.producthunt.com/feed', 'Product Hunt'),
    ('https://news.google.com/rss/search?q=("unicorn+startup"+OR+"unicorn+valuation"+OR+"$1+billion+valuation")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Unicorn News'),
    ('https://news.google.com/rss/search?q=site:cbinsights.com+unicorn+when:14d&hl=en-US&gl=US&ceid=US:en', 'CB Insights Unicorn'),
    ('https://news.google.com/rss/search?q=("decacorn"+OR+"$10+billion+valuation"+OR+"$10B+valuation")+startup+when:14d&hl=en-US&gl=US&ceid=US:en', 'Decacorn News'),
    ('https://news.google.com/rss/search?q=("becomes+unicorn"+OR+"joins+unicorn"+OR+"reaches+unicorn"+OR+"achieved+unicorn")+when:14d&hl=en-US&gl=US&ceid=US:en', 'New Unicorns'),
    ('https://news.google.com/rss/search?q=Techstars+accelerator+when:14d&hl=en-US&gl=US&ceid=US:en', 'Techstars News'),
    ('https://news.google.com/rss/search?q="500+Global"+OR+"500+Startups"+accelerator+when:14d&hl=en-US&gl=US&ceid=US:en', '500 Global News'),
    ('https://news.google.com/rss/search?q=("demo+day"+OR+"YC+batch"+OR+"accelerator+batch")+startup+when:7d&hl=en-US&gl=US&ceid=US:en', 'Demo Day News'),
    ('https://news.google.com/rss/search?q="Startup+School"+OR+"YC+Startup+School"+when:14d&hl=en-US&gl=US&ceid=US:en', 'Startup School'),
    ('https://news.google.com/rss/search?q="Acquired+podcast"+episode+when:14d&hl=en-US&gl=US&ceid=US:en', 'Acquired Episodes'),
    ('https://news.google.com/rss/search?q="All-In+podcast"+(Chamath+OR+Sacks+OR+Friedberg)+when:7d&hl=en-US&gl=US&ceid=US:en', 'All-In Podcast'),
    ('https://news.google.com/rss/search?q=("a16z"+OR+"Andreessen+Horowitz")+podcast+OR+interview+when:14d&hl=en-US&gl=US&ceid=US:en', 'a16z Insights'),
    ('https://news.google.com/rss/search?q="This+Week+in+Startups"+Jason+Calacanis+when:14d&hl=en-US&gl=US&ceid=US:en', 'TWIST Episodes'),
    ('https://news.google.com/rss/search?q=("Benedict+Evans"+OR+"Pragmatic+Engineer"+OR+Stratechery)+tech+when:14d&hl=en-US&gl=US&ceid=US:en', 'Tech Newsletters'),
    ('https://news.google.com/rss/search?q="How+I+Built+This"+Guy+Raz+when:14d&hl=en-US&gl=US&ceid=US:en', 'How I Built This'),

    # ── Regional Startups (31) ────────────────────────────────────
    ('https://news.google.com/rss/search?q=site:eu-startups.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'EU Startups'),
    ('https://tech.eu/feed/', 'Tech.eu'),
    ('https://news.google.com/rss/search?q=site:thenextweb.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'The Next Web'),
    ('https://news.google.com/rss/search?q=site:techinasia.com+when:7d&hl=en-US&gl=US&ceid=US:en', 'Tech in Asia'),
    ('https://news.google.com/rss/search?q=site:kr-asia.com+OR+KrASIA+when:7d&hl=en-US&gl=US&ceid=US:en', 'KrASIA'),
    ('https://news.google.com/rss/search?q=(Singapore+OR+Indonesia+OR+Vietnam+OR+Thailand+OR+Malaysia)+startup+funding+when:7d&hl=en-US&gl=US&ceid=US:en', 'SEA Startups'),
    ('https://news.google.com/rss/search?q=("Southeast+Asia"+OR+ASEAN)+venture+capital+OR+funding+when:7d&hl=en-US&gl=US&ceid=US:en', 'Asia VC News'),
    ('https://news.google.com/rss/search?q=China+startup+funding+OR+"Chinese+startup"+when:7d&hl=en-US&gl=US&ceid=US:en', 'China Startups'),
    ('https://news.google.com/rss/search?q=site:36kr.com+OR+"36Kr"+startup+china+when:7d&hl=en-US&gl=US&ceid=US:en', '36Kr English'),
    ('https://news.google.com/rss/search?q=(Alibaba+OR+Tencent+OR+ByteDance+OR+Baidu+OR+JD.com+OR+Xiaomi+OR+Huawei)+when:3d&hl=en-US&gl=US&ceid=US:en', 'China Tech Giants'),
    ('https://news.google.com/rss/search?q=Japan+startup+funding+OR+"Japanese+startup"+when:7d&hl=en-US&gl=US&ceid=US:en', 'Japan Startups'),
    ('https://news.google.com/rss/search?q=(Japan+startup+OR+Japan+tech+OR+SoftBank+OR+Rakuten+OR+Sony)+funding+when:7d&hl=en-US&gl=US&ceid=US:en', 'Japan Tech News'),
    ('https://news.google.com/rss/search?q=site:asia.nikkei.com+technology+when:3d&hl=en-US&gl=US&ceid=US:en', 'Nikkei Tech'),
    ('https://news.google.com/rss/search?q=(Korea+startup+OR+Korean+tech+OR+Samsung+OR+Kakao+OR+Naver+OR+Coupang)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Korea Tech News'),
    ('https://news.google.com/rss/search?q=Korea+startup+funding+OR+"Korean+unicorn"+when:7d&hl=en-US&gl=US&ceid=US:en', 'Korea Startups'),
    ('https://inc42.com/feed/', 'Inc42 (India)'),
    ('https://yourstory.com/feed', 'YourStory'),
    ('https://news.google.com/rss/search?q=India+startup+funding+OR+"Indian+startup"+when:7d&hl=en-US&gl=US&ceid=US:en', 'India Startups'),
    ('https://news.google.com/rss/search?q=(Flipkart+OR+Razorpay+OR+Zerodha+OR+Zomato+OR+Paytm+OR+PhonePe)+when:7d&hl=en-US&gl=US&ceid=US:en', 'India Tech News'),
    ('https://news.google.com/rss/search?q=(Grab+OR+GoTo+OR+Sea+Limited+OR+Shopee+OR+Tokopedia)+when:7d&hl=en-US&gl=US&ceid=US:en', 'SEA Tech News'),
    ('https://news.google.com/rss/search?q=Vietnam+startup+OR+Vietnam+tech+when:7d&hl=en-US&gl=US&ceid=US:en', 'Vietnam Tech'),
    ('https://news.google.com/rss/search?q=Indonesia+startup+OR+Indonesia+tech+when:7d&hl=en-US&gl=US&ceid=US:en', 'Indonesia Tech'),
    ('https://news.google.com/rss/search?q=(Taiwan+startup+OR+TSMC+OR+MediaTek+OR+Foxconn)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Taiwan Tech'),
    ('https://news.google.com/rss/search?q=site:lavca.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'LAVCA (LATAM)'),
    ('https://news.google.com/rss/search?q=("Latin+America"+startup+OR+LATAM+funding)+when:7d&hl=en-US&gl=US&ceid=US:en', 'LATAM Startups'),
    ('https://news.google.com/rss/search?q=(Nubank+OR+iFood+OR+Mercado+Libre+OR+Rappi+OR+VTEX)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Brazil Tech'),
    ('https://techcabal.com/feed/', 'TechCabal (Africa)'),
    ('https://news.google.com/rss/search?q=Africa+startup+funding+OR+"African+startup"+when:7d&hl=en-US&gl=US&ceid=US:en', 'Africa Startups'),
    ('https://news.google.com/rss/search?q=(Flutterwave+OR+Paystack+OR+Jumia+OR+Andela+OR+"Africa+startup")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Africa Tech News'),
    ('https://news.google.com/rss/search?q=(MENA+startup+OR+"Middle+East"+funding+OR+Gulf+startup)+when:7d&hl=en-US&gl=US&ceid=US:en', 'MENA Startups'),
    ('https://news.google.com/rss/search?q=(UAE+startup+OR+Saudi+tech+OR+Dubai+startup+OR+NEOM+tech)+when:7d&hl=en-US&gl=US&ceid=US:en', 'MENA Tech News'),

    # ── Think Tanks & Policy (38) ─────────────────────────────────
    ('https://rss.politico.com/politics-news.xml', 'Politico'),
    ('https://foreignpolicy.com/feed/', 'Foreign Policy'),
    ('https://www.atlanticcouncil.org/feed/', 'Atlantic Council'),
    ('https://www.foreignaffairs.com/rss.xml', 'Foreign Affairs'),
    ('https://news.google.com/rss/search?q=site:csis.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'CSIS'),
    ('https://news.google.com/rss/search?q=site:rand.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'RAND'),
    ('https://news.google.com/rss/search?q=site:brookings.edu+when:7d&hl=en-US&gl=US&ceid=US:en', 'Brookings'),
    ('https://news.google.com/rss/search?q=site:carnegieendowment.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'Carnegie'),
    ('https://www.aei.org/feed/', 'AEI'),
    ('https://news.google.com/rss/search?q=site:rusi.org+when:3d&hl=en-US&gl=US&ceid=US:en', 'RUSI'),
    ('https://www.fpri.org/feed/', 'FPRI'),
    ('https://jamestown.org/feed/', 'Jamestown'),
    ('https://rss.politico.com/technology.xml', 'Politico Tech'),
    ('https://news.google.com/rss/search?q=AI+regulation+OR+"artificial+intelligence"+law+OR+policy+when:7d&hl=en-US&gl=US&ceid=US:en', 'AI Regulation'),
    ('https://news.google.com/rss/search?q=tech+antitrust+OR+FTC+Google+OR+FTC+Apple+OR+FTC+Amazon+when:7d&hl=en-US&gl=US&ceid=US:en', 'Tech Antitrust'),
    ('https://news.google.com/rss/search?q=site:eff.org+OR+"Electronic+Frontier+Foundation"+when:14d&hl=en-US&gl=US&ceid=US:en', 'EFF News'),
    ('https://news.google.com/rss/search?q=("Digital+Services+Act"+OR+"Digital+Markets+Act"+OR+"EU+AI+Act"+OR+"GDPR")+when:7d&hl=en-US&gl=US&ceid=US:en', 'EU Digital Policy'),
    ('https://news.google.com/rss/search?q=site:euractiv.com+digital+OR+tech+when:7d&hl=en-US&gl=US&ceid=US:en', 'Euractiv Digital'),
    ('https://news.google.com/rss/search?q=site:ec.europa.eu+digital+OR+technology+when:14d&hl=en-US&gl=US&ceid=US:en', 'EU Commission Digital'),
    ('https://news.google.com/rss/search?q=(China+tech+regulation+OR+China+AI+policy+OR+MIIT+technology)+when:7d&hl=en-US&gl=US&ceid=US:en', 'China Tech Policy'),
    ('https://news.google.com/rss/search?q=(UK+AI+safety+OR+"Online+Safety+Bill"+OR+UK+tech+regulation)+when:7d&hl=en-US&gl=US&ceid=US:en', 'UK Tech Policy'),
    ('https://news.google.com/rss/search?q=(India+tech+regulation+OR+India+data+protection+OR+India+AI+policy)+when:7d&hl=en-US&gl=US&ceid=US:en', 'India Tech Policy'),
    ('https://news.google.com/rss/search?q=site:brookings.edu+technology+OR+AI+when:14d&hl=en-US&gl=US&ceid=US:en', 'Brookings Tech'),
    ('https://news.google.com/rss/search?q=site:csis.org+technology+OR+AI+when:14d&hl=en-US&gl=US&ceid=US:en', 'CSIS Tech'),
    ('https://news.google.com/rss/search?q=%22Tech+Policy+Press%22&hl=en&gl=US&ceid=US:en', 'MIT Tech Policy'),
    ('https://news.google.com/rss/search?q=site:hai.stanford.edu+when:14d&hl=en-US&gl=US&ceid=US:en', 'Stanford HAI'),
    ('https://news.google.com/rss/search?q=%22AI+Now+Institute%22&hl=en&gl=US&ceid=US:en', 'AI Now Institute'),
    ('https://news.google.com/rss/search?q=site:oecd.org+digital+OR+AI+when:14d&hl=en-US&gl=US&ceid=US:en', 'OECD Digital'),
    ('https://news.google.com/rss/search?q=("EU+tech+policy"+OR+"European+digital"+OR+Bruegel+tech)+when:14d&hl=en-US&gl=US&ceid=US:en', 'EU Tech Policy'),
    ('https://news.google.com/rss/search?q=site:chathamhouse.org+technology+OR+AI+when:14d&hl=en-US&gl=US&ceid=US:en', 'Chatham House Tech'),
    ('https://news.google.com/rss/search?q=site:iseas.edu.sg+technology+when:14d&hl=en-US&gl=US&ceid=US:en', 'ISEAS (Singapore)'),
    ('https://news.google.com/rss/search?q=(India+tech+policy+OR+ORF+technology+OR+"Observer+Research+Foundation"+tech)+when:14d&hl=en-US&gl=US&ceid=US:en', 'ORF Tech (India)'),
    ('https://news.google.com/rss/search?q=site:rieti.go.jp+technology+when:30d&hl=en-US&gl=US&ceid=US:en', 'RIETI (Japan)'),
    ('https://news.google.com/rss/search?q=("Asia+Pacific"+tech+policy+OR+"Lowy+Institute"+technology)+when:14d&hl=en-US&gl=US&ceid=US:en', 'Asia Pacific Tech'),
    ('https://news.google.com/rss/search?q=("China+tech+strategy"+OR+"Chinese+AI"+OR+"China+semiconductor")+analysis+when:7d&hl=en-US&gl=US&ceid=US:en', 'China Tech Analysis'),
    ('https://news.google.com/rss/search?q=DigiChina+Stanford+China+technology&hl=en&gl=US&ceid=US:en', 'DigiChina'),
    ('https://news.google.com/rss/search?q=site:chathamhouse.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'Chatham House'),
    ('https://news.google.com/rss/search?q=site:lowyinstitute.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'Lowy Institute'),

    # ── Energy & Commodities (5) ─────────────────────────────────
    ('https://news.google.com/rss/search?q=(oil+price+OR+OPEC+OR+"natural+gas"+OR+pipeline+OR+LNG)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Oil & Gas'),
    ('https://news.google.com/rss/search?q=(lithium+OR+"rare+earth"+OR+cobalt+OR+mining)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Mining & Resources'),
    ('https://news.google.com/rss/search?q=(gold+price+OR+silver+price+OR+copper+OR+platinum+OR+"precious+metals")+when:2d&hl=en-US&gl=US&ceid=US:en', 'Gold & Metals'),
    ('https://news.google.com/rss/search?q=(wheat+OR+corn+OR+soybeans+OR+coffee+OR+sugar)+price+OR+commodity+when:3d&hl=en-US&gl=US&ceid=US:en', 'Agriculture'),
    ('https://news.google.com/rss/search?q=("commodity+trading"+OR+"futures+market"+OR+CME+OR+NYMEX+OR+COMEX)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Commodity Trading'),

    # ── Crypto & Fintech (9) ─────────────────────────────────────
    ('https://news.google.com/rss/search?q=fintech+(Brazil+OR+Mexico+OR+Argentina+OR+"Latin+America")+when:7d&hl=en-US&gl=US&ceid=US:en', 'FinTech LATAM'),
    ('https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'),
    ('https://cointelegraph.com/rss', 'Cointelegraph'),
    ('https://news.google.com/rss/search?q=(bitcoin+OR+ethereum+OR+crypto+OR+"digital+assets")+when:1d&hl=en-US&gl=US&ceid=US:en', 'Crypto News'),
    ('https://news.google.com/rss/search?q=(DeFi+OR+"decentralized+finance"+OR+DEX+OR+"yield+farming")+when:3d&hl=en-US&gl=US&ceid=US:en', 'DeFi News'),
    ('https://news.google.com/rss/search?q=(fintech+OR+"payment+technology"+OR+"neobank"+OR+"digital+banking")+when:3d&hl=en-US&gl=US&ceid=US:en', 'Fintech News'),
    ('https://news.google.com/rss/search?q=("algorithmic+trading"+OR+"trading+platform"+OR+"quantitative+finance")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Trading Tech'),
    ('https://news.google.com/rss/search?q=("blockchain+finance"+OR+"tokenization"+OR+"digital+securities"+OR+CBDC)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Blockchain Finance'),
    ('https://news.google.com/rss/search?q=(crypto+regulation+OR+"digital+asset"+regulation+OR+"stablecoin"+regulation)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Crypto Regulation'),

    # ── Central Banks & Economics (11) ────────────────────────────
    ('https://stratechery.com/feed/', 'Stratechery'),
    ('https://news.google.com/rss/search?q=("central+bank"+OR+"interest+rate"+OR+"rate+decision"+OR+"monetary+policy")+when:2d&hl=en-US&gl=US&ceid=US:en', 'Central Bank Rates'),
    ('https://news.google.com/rss/search?q=("corporate+bond"+OR+"high+yield"+OR+"investment+grade"+OR+"credit+spread")+when:3d&hl=en-US&gl=US&ceid=US:en', 'Corporate Bonds'),
    ('https://news.google.com/rss/search?q=("European+Central+Bank"+OR+ECB+OR+Lagarde)+monetary+policy+when:3d&hl=en-US&gl=US&ceid=US:en', 'ECB Watch'),
    ('https://news.google.com/rss/search?q=("Bank+of+Japan"+OR+BoJ)+monetary+policy+when:3d&hl=en-US&gl=US&ceid=US:en', 'BoJ Watch'),
    ('https://news.google.com/rss/search?q=("Bank+of+England"+OR+BoE)+monetary+policy+when:3d&hl=en-US&gl=US&ceid=US:en', 'BoE Watch'),
    ('https://news.google.com/rss/search?q=("People%27s+Bank+of+China"+OR+PBoC+OR+PBOC)+when:7d&hl=en-US&gl=US&ceid=US:en', 'PBoC Watch'),
    ('https://news.google.com/rss/search?q=("rate+hike"+OR+"rate+cut"+OR+"interest+rate+decision")+central+bank+when:3d&hl=en-US&gl=US&ceid=US:en', 'Global Central Banks'),
    ('https://news.google.com/rss/search?q=(CPI+OR+inflation+OR+GDP+OR+"jobs+report"+OR+"nonfarm+payrolls"+OR+PMI)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Economic Data'),
    ('https://news.google.com/rss/search?q=(tariff+OR+"trade+war"+OR+"trade+deficit"+OR+sanctions)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Trade & Tariffs'),
    ('https://news.google.com/rss/search?q=("housing+market"+OR+"home+prices"+OR+"mortgage+rates"+OR+REIT)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Housing Market'),

    # ── Financial Markets Deep (20) ───────────────────────────────
    ('https://news.google.com/rss/search?q=(IPO+OR+"initial+public+offering"+OR+SPAC)+tech+when:7d&hl=en-US&gl=US&ceid=US:en', 'IPO News'),
    ('https://news.google.com/rss/search?q=site:renaissancecapital.com+IPO+when:14d&hl=en-US&gl=US&ceid=US:en', 'Renaissance IPO'),
    ('https://news.google.com/rss/search?q=tech+IPO+OR+"tech+company"+IPO+when:7d&hl=en-US&gl=US&ceid=US:en', 'Tech IPO News'),
    ('https://seekingalpha.com/market_currents.xml', 'Seeking Alpha Tech'),
    ('https://news.google.com/rss/search?q=site:investing.com+markets+when:1d&hl=en-US&gl=US&ceid=US:en', 'Investing.com News'),
    ('https://news.google.com/rss/search?q=("forex"+OR+"currency"+OR+"FX+market")+trading+when:1d&hl=en-US&gl=US&ceid=US:en', 'Forex News'),
    ('https://news.google.com/rss/search?q=("dollar+index"+OR+DXY+OR+"US+dollar"+OR+"euro+dollar")+when:2d&hl=en-US&gl=US&ceid=US:en', 'Dollar Watch'),
    ('https://news.google.com/rss/search?q=("bond+market"+OR+"treasury+yields"+OR+"bond+yields"+OR+"fixed+income")+when:2d&hl=en-US&gl=US&ceid=US:en', 'Bond Market'),
    ('https://news.google.com/rss/search?q=("earnings+report"+OR+"quarterly+earnings"+OR+"revenue+beat"+OR+"earnings+miss")+when:2d&hl=en-US&gl=US&ceid=US:en', 'Earnings Reports'),
    ('https://news.google.com/rss/search?q=("merger"+OR+"acquisition"+OR+"takeover+bid"+OR+"buyout")+billion+when:3d&hl=en-US&gl=US&ceid=US:en', 'M&A News'),
    ('https://news.google.com/rss/search?q=("options+market"+OR+"options+trading"+OR+"put+call+ratio"+OR+VIX)+when:2d&hl=en-US&gl=US&ceid=US:en', 'Options Market'),
    ('https://news.google.com/rss/search?q=("futures+trading"+OR+"S%26P+500+futures"+OR+"Nasdaq+futures")+when:1d&hl=en-US&gl=US&ceid=US:en', 'Futures Trading'),
    ('https://news.google.com/rss/search?q=(SEC+OR+CFTC+OR+FINRA+OR+FCA)+regulation+OR+enforcement+when:3d&hl=en-US&gl=US&ceid=US:en', 'Financial Regulation'),
    ('https://news.google.com/rss/search?q=(Basel+OR+"capital+requirements"+OR+"banking+regulation")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Banking Rules'),
    ('https://news.google.com/rss/search?q=("hedge+fund"+OR+"Bridgewater"+OR+"Citadel"+OR+"Renaissance")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Hedge Fund News'),
    ('https://news.google.com/rss/search?q=("private+equity"+OR+Blackstone+OR+KKR+OR+Apollo+OR+Carlyle)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Private Equity'),
    ('https://news.google.com/rss/search?q=("sovereign+wealth+fund"+OR+"pension+fund"+OR+"institutional+investor")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Sovereign Wealth'),
    ('https://news.google.com/rss/search?q=("market+outlook"+OR+"stock+market+forecast"+OR+"bull+market"+OR+"bear+market")+when:3d&hl=en-US&gl=US&ceid=US:en', 'Market Outlook'),
    ('https://news.google.com/rss/search?q=(VIX+OR+"market+volatility"+OR+"risk+off"+OR+"market+correction")+when:3d&hl=en-US&gl=US&ceid=US:en', 'Risk & Volatility'),
    ('https://news.google.com/rss/search?q=("Goldman+Sachs"+OR+"JPMorgan"+OR+"Morgan+Stanley")+forecast+OR+outlook+when:3d&hl=en-US&gl=US&ceid=US:en', 'Bank Research'),

    # ── Defense & Security (17) ───────────────────────────────────
    ('https://warontherocks.com/feed', 'War on the Rocks'),
    ('https://news.google.com/rss/search?q=("nuclear+energy"+OR+"nuclear+power"+OR+uranium+OR+IAEA)+when:3d&hl=en-US&gl=US&ceid=US:en', 'Nuclear Energy'),
    ('https://news.google.com/rss/search?q=(Azure+OR+GCP+OR+Cloudflare+OR+Slack+OR+GitHub)+outage+OR+down+when:1d&hl=en-US&gl=US&ceid=US:en', 'Cloud Outages'),
    ('https://www.darkreading.com/rss.xml', 'Dark Reading'),
    ('https://www.schneier.com/feed/', 'Schneier'),
    ('https://www.defenseone.com/rss/all/', 'Defense One'),
    ('https://breakingdefense.com/feed/', 'Breaking Defense'),
    ('https://www.twz.com/feed', 'The War Zone'),
    ('https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', 'Defense News'),
    ('https://news.google.com/rss/search?q=site:janes.com+when:3d&hl=en-US&gl=US&ceid=US:en', 'Janes'),
    ('https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml', 'Military Times'),
    ('https://news.usni.org/feed', 'USNI News'),
    ('https://www.oryxspioenkop.com/feeds/posts/default?alt=rss', 'Oryx OSINT'),
    ('https://www.gov.uk/government/organisations/ministry-of-defence.atom', 'UK MOD'),
    ('https://news.google.com/rss/search?q=site:armscontrol.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'Arms Control Assn'),
    ('https://news.google.com/rss/search?q=site:thebulletin.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'Bulletin of Atomic Scientists'),
    ('https://www.ransomware.live/rss.xml', 'Ransomware.live'),

    # ── Crisis & International Orgs (5) ──────────────────────────
    ('https://news.un.org/feed/subscribe/en/news/all/rss.xml', 'UN News'),
    ('https://www.crisisgroup.org/rss', 'CrisisWatch'),
    ('https://www.iaea.org/feeds/topnews', 'IAEA'),
    ('https://www.who.int/rss-feeds/news-english.xml', 'WHO'),
    ('https://news.google.com/rss/search?q=site:unhcr.org+OR+UNHCR+refugees+when:3d&hl=en-US&gl=US&ceid=US:en', 'UNHCR'),

    # ── Science & Innovation (7) ─────────────────────────────────
    ('https://www.goodnewsnetwork.org/category/news/science/feed/', 'GNN Science'),
    ('https://www.sciencedaily.com/rss/all.xml', 'ScienceDaily'),
    ('https://feeds.nature.com/nature/rss/current', 'Nature News'),
    ('https://www.livescience.com/feeds.xml', 'Live Science'),
    ('https://singularityhub.com/feed/', 'Singularity Hub'),
    ('https://humanprogress.org/feed/', 'Human Progress'),
    ('https://greatergood.berkeley.edu/site/rss/articles', 'Greater Good (Berkeley)'),

    # ── Developer & Open Source (11) ──────────────────────────────
    ('https://github.blog/feed/', 'GitHub Blog'),
    ('https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml', 'GitHub Trending'),
    ('https://hnrss.org/show', 'Show HN'),
    ('https://news.google.com/rss/search?q=("developer+conference"+OR+"tech+summit"+OR+"devcon"+OR+"developer+event")+when:7d&hl=en-US&gl=US&ceid=US:en', 'Dev Events'),
    ('https://news.google.com/rss/search?q="open+source"+project+release+OR+launch+when:3d&hl=en-US&gl=US&ceid=US:en', 'Open Source News'),
    ('https://feed.infoq.com/', 'InfoQ'),
    ('https://thenewstack.io/feed/', 'The New Stack'),
    ('https://devops.com/feed/', 'DevOps.com'),
    ('https://dev.to/feed', 'Dev.to'),
    ('https://lobste.rs/rss', 'Lobsters'),
    ('https://changelog.com/feed', 'Changelog'),

    # ── Positive News (10) ────────────────────────────────────────
    ('https://www.goodnewsnetwork.org/feed/', 'Good News Network'),
    ('https://www.positive.news/feed/', 'Positive.News'),
    ('https://reasonstobecheerful.world/feed/', 'Reasons to be Cheerful'),
    ('https://www.optimistdaily.com/feed/', 'Optimist Daily'),
    ('https://www.upworthy.com/feed/', 'Upworthy'),
    ('https://www.dailygood.org/feed', 'DailyGood'),
    ('https://www.goodgoodgood.co/articles/rss.xml', 'Good Good Good'),
    ('https://www.good.is/feed/', 'GOOD Magazine'),
    ('https://www.sunnyskyz.com/rss_tebow.php', 'Sunny Skyz'),
    ('https://thebetterindia.com/feed/', 'The Better India'),

    # ── Other (24) ────────────────────────────────────────────────
    ('https://news.mit.edu/rss/research', 'MIT Research'),
    ('https://www.ycombinator.com/blog/rss/', 'Y Combinator Blog'),
    ('https://news.google.com/rss/search?q=(startup+Brazil+OR+startup+Mexico+OR+startup+Argentina+OR+startup+Colombia+OR+startup+Chile)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Startups LATAM'),
    ('https://news.google.com/rss/search?q=AWS+outage+OR+"Amazon+Web+Services"+down+when:1d&hl=en-US&gl=US&ceid=US:en', 'AWS Status'),
    ('https://news.google.com/rss/search?q=("Lex+Fridman"+interview)+(AI+OR+tech+OR+startup+OR+CEO)+when:7d&hl=en-US&gl=US&ceid=US:en', 'Lex Fridman Tech'),
    ('https://news.google.com/rss/search?q="Hard+Fork"+podcast+NYT+when:14d&hl=en-US&gl=US&ceid=US:en', 'Hard Fork (NYT)'),
    ('https://news.google.com/rss/search?q=site:theblock.co+when:1d&hl=en-US&gl=US&ceid=US:en', 'The Block'),
    ('https://www.newscientist.com/feed/home/', 'New Scientist'),
    ('https://www.goodnewsnetwork.org/category/news/animals/feed/', 'GNN Animals'),
    ('https://www.goodnewsnetwork.org/category/news/health/feed/', 'GNN Health'),
    ('https://www.goodnewsnetwork.org/category/news/inspiring/feed/', 'GNN Heroes'),
    ('https://taskandpurpose.com/feed/', 'Task & Purpose'),
    ('https://gcaptain.com/feed/', 'gCaptain'),
    ('https://news.google.com/rss/search?q=site:ecfr.eu+when:7d&hl=en-US&gl=US&ceid=US:en', 'ECFR'),
    ('https://news.google.com/rss/search?q=site:mei.edu+when:7d&hl=en-US&gl=US&ceid=US:en', 'Middle East Institute'),
    ('https://news.google.com/rss/search?q=site:fas.org+nuclear+weapons+security&hl=en&gl=US&ceid=US:en', 'FAS'),
    ('https://news.google.com/rss/search?q=site:nti.org+when:30d&hl=en-US&gl=US&ceid=US:en', 'NTI'),
    ('https://news.google.com/rss/search?q=site:wilsoncenter.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'Wilson Center'),
    ('https://news.google.com/rss/search?q=site:gmfus.org+when:7d&hl=en-US&gl=US&ceid=US:en', 'GMF'),
    ('https://www.stimson.org/feed/', 'Stimson Center'),
    ('https://news.google.com/rss/search?q=site:bellingcat.com+when:30d&hl=en-US&gl=US&ceid=US:en', 'Bellingcat'),
    ('https://www.fao.org/feeds/fao-newsroom-rss', 'FAO News'),
    ('https://news.google.com/rss/search?q=site:fao.org+GIEWS+food+security+when:30d&hl=en-US&gl=US&ceid=US:en', 'FAO GIEWS'),
    ('https://news.google.com/rss/search?q=site:iss.europa.eu+when:7d&hl=en-US&gl=US&ceid=US:en', 'EU ISS'),
]

# ── Yahoo Finance Global Indices ────────────────────────────────────────────

GLOBAL_INDICES = {
    '^GSPC': 'S&P 500',
    '^IXIC': 'Nasdaq',
    '^DJI': 'Dow Jones',
    '^HSI': 'Hang Seng',
    '^N225': 'Nikkei 225',
    '^STOXX50E': 'Euro Stoxx 50',
    '^VIX': 'VIX恐慌指数',
    'GC=F': '黄金期货',
    'CL=F': '原油期货',
    'USDCNY=X': 'USD/CNY',
}

# ── Polymarket Tags ─────────────────────────────────────────────────────────

POLY_TAGS = ['china', 'trade', 'fed', 'economy', 'ai']

# ── Thread-safe caches ──────────────────────────────────────────────────────

_rss_cache = {'data': None, 'ts': 0}
_rss_lock = threading.Lock()
_RSS_CACHE_TTL = 1800  # 30 min

_indices_cache = {'data': None, 'ts': 0}
_indices_lock = threading.Lock()
_INDICES_CACHE_TTL = 1800  # 30 min

_poly_cache = {'data': None, 'ts': 0}
_poly_lock = threading.Lock()
_POLY_CACHE_TTL = 3600  # 1 hour


# ── RSS News Fetching ───────────────────────────────────────────────────────

def _parse_rss_xml(xml_text: str, source_name: str, max_items: int = 5) -> list:
    """Parse RSS XML and extract items."""
    items = []
    try:
        root = ET.fromstring(xml_text)
        # Handle both RSS 2.0 (<channel><item>) and Atom (<entry>)
        channel = root.find('channel')
        if channel is not None:
            for item in channel.findall('item')[:max_items]:
                title = (item.findtext('title') or '').strip()
                link = (item.findtext('link') or '').strip()
                pub_date = (item.findtext('pubDate') or '').strip()
                if title:
                    items.append({
                        'title': title,
                        'source': source_name,
                        'published': pub_date,
                        'link': link,
                    })
        else:
            # Atom format
            ns = {'atom': 'http://www.w3.org/2005/Atom'}
            for entry in root.findall('atom:entry', ns)[:max_items]:
                title = (entry.findtext('atom:title', '', ns) or '').strip()
                link_el = entry.find('atom:link', ns)
                link = link_el.get('href', '') if link_el is not None else ''
                pub_date = (entry.findtext('atom:published', '', ns) or
                            entry.findtext('atom:updated', '', ns) or '').strip()
                if title:
                    items.append({
                        'title': title,
                        'source': source_name,
                        'published': pub_date,
                        'link': link,
                    })
    except ET.ParseError as e:
        logger.debug(f'RSS parse error for {source_name}: {e}')
    return items


def fetch_rss_news(max_per_source: int = 3) -> list:
    """Fetch RSS news from all sources via relay. Parallelized + thread-safe cached."""
    now = time.time()
    with _rss_lock:
        if _rss_cache['data'] is not None and (now - _rss_cache['ts']) < _RSS_CACHE_TTL:
            return _rss_cache['data']

    # Also check Redis (only use if non-empty)
    redis_key = 'cn:global-rss:all'
    cached = cache_get(redis_key)
    if cached:
        with _rss_lock:
            _rss_cache['data'] = cached
            _rss_cache['ts'] = time.time()
        return cached

    relay_url = getattr(Config, 'RELAY_URL', 'http://localhost:3004')
    all_items = []
    ok_count = 0

    def _fetch_one_feed(feed_url, source_name):
        try:
            resp = requests.get(
                f'{relay_url}/rss',
                params={'url': feed_url},
                timeout=8,
            )
            if resp.status_code == 200:
                return _parse_rss_xml(resp.text, source_name, max_per_source)
            else:
                logger.debug(f'RSS {source_name} returned {resp.status_code}')
        except Exception as e:
            logger.debug(f'RSS {source_name} fetch failed: {e}')
        return []

    # Parallel fetch all feeds (max 20 concurrent, 45s overall deadline)
    with ThreadPoolExecutor(max_workers=20) as pool:
        futures = {
            pool.submit(_fetch_one_feed, url, name): name
            for url, name in RSS_FEEDS
        }
        for future in as_completed(futures, timeout=45):
            try:
                items = future.result()
                if items:
                    all_items.extend(items)
                    ok_count += 1
            except Exception:
                pass

    # Deduplicate by title similarity (exact match)
    seen_titles = set()
    deduped = []
    for item in all_items:
        title_key = item['title'].lower().strip()
        if title_key not in seen_titles:
            seen_titles.add(title_key)
            deduped.append(item)

    if deduped:
        with _rss_lock:
            _rss_cache['data'] = deduped
            _rss_cache['ts'] = time.time()
        cache_set(redis_key, deduped, _RSS_CACHE_TTL)
        logger.warning(f'RSS fetched {len(deduped)} items from {ok_count}/{len(RSS_FEEDS)} sources')
    else:
        logger.warning(f'RSS fetch returned 0 items from {len(RSS_FEEDS)} sources')
        # Return stale if available
        with _rss_lock:
            return _rss_cache['data'] or []
    return deduped


# ── Yahoo Finance Indices ───────────────────────────────────────────────────

def fetch_global_indices() -> dict:
    """Fetch global index quotes via relay yahoo-chart. Thread-safe cached."""
    now = time.time()
    with _indices_lock:
        if _indices_cache['data'] is not None and (now - _indices_cache['ts']) < _INDICES_CACHE_TTL:
            return _indices_cache['data']

    redis_key = 'cn:global-indices'
    cached = cache_get(redis_key)
    if cached:
        with _indices_lock:
            _indices_cache['data'] = cached
            _indices_cache['ts'] = time.time()
        return cached

    relay_url = getattr(Config, 'RELAY_URL', 'http://localhost:3004')
    result = {}

    def _fetch_one_index(symbol, name):
        try:
            resp = requests.get(
                f'{relay_url}/yahoo-chart',
                params={'symbol': symbol, 'interval': '1d', 'range': '5d'},
                timeout=4,
            )
            if resp.status_code == 200:
                data = resp.json()
                chart = data.get('chart', {}).get('result', [{}])[0]
                meta = chart.get('meta', {})
                price = meta.get('regularMarketPrice', 0)
                prev_close = meta.get('previousClose') or meta.get('chartPreviousClose', 0)
                change = price - prev_close if price and prev_close else 0
                change_pct = (change / prev_close * 100) if prev_close else 0
                return symbol, {
                    'name': name,
                    'price': round(price, 2) if price else 0,
                    'change': round(change, 2),
                    'changePct': round(change_pct, 2),
                }
        except Exception as e:
            logger.debug(f'Yahoo {symbol} fetch failed: {e}')
        return symbol, None

    # Parallel fetch all indices (max 5 concurrent, 8s overall deadline)
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(_fetch_one_index, sym, nm): sym for sym, nm in GLOBAL_INDICES.items()}
        for future in as_completed(futures, timeout=8):
            try:
                sym, data = future.result()
                if data:
                    result[sym] = data
            except Exception:
                pass

    if result:
        with _indices_lock:
            _indices_cache['data'] = result
            _indices_cache['ts'] = time.time()
        cache_set(redis_key, result, _INDICES_CACHE_TTL)
        logger.warning(f'Yahoo indices fetched {len(result)} symbols')
    else:
        logger.warning('Yahoo indices fetch returned 0 results')
        # Return stale if available
        with _indices_lock:
            return _indices_cache['data'] or {}

    return result


# ── Polymarket Prediction Markets ───────────────────────────────────────────

def fetch_polymarket() -> list:
    """Fetch prediction market data via relay polymarket endpoint. Thread-safe cached."""
    now = time.time()
    with _poly_lock:
        if _poly_cache['data'] is not None and (now - _poly_cache['ts']) < _POLY_CACHE_TTL:
            return _poly_cache['data']

    redis_key = 'cn:global-polymarket'
    cached = cache_get(redis_key)
    if cached:
        with _poly_lock:
            _poly_cache['data'] = cached
            _poly_cache['ts'] = time.time()
        return cached

    relay_url = getattr(Config, 'RELAY_URL', 'http://localhost:3004')
    all_markets = []

    for tag in POLY_TAGS:
        try:
            resp = requests.get(
                f'{relay_url}/polymarket',
                params={'endpoint': 'events', 'tag': tag, 'limit': 10,
                        'order': 'volume', 'closed': 'false'},
                timeout=6,
            )
            if resp.status_code == 200:
                events = resp.json()
                if isinstance(events, list):
                    for evt in events[:10]:
                        title = evt.get('title', '') or evt.get('question', '')
                        volume = float(evt.get('volume', 0) or 0)
                        # Events have nested markets — extract top market probability
                        prob = 0
                        markets_list = evt.get('markets', [])
                        if markets_list and isinstance(markets_list, list):
                            top_m = markets_list[0]
                            outcome_prices = top_m.get('outcomePrices')
                            if outcome_prices:
                                try:
                                    prices = json.loads(outcome_prices) if isinstance(outcome_prices, str) else outcome_prices
                                    if isinstance(prices, list) and prices:
                                        prob = round(float(prices[0]) * 100, 1)
                                except (json.JSONDecodeError, ValueError, IndexError):
                                    pass
                        if title:
                            all_markets.append({
                                'question': title,
                                'probability': prob,
                                'volume': round(volume, 0),
                                'tag': tag,
                            })
        except Exception as e:
            logger.debug(f'Polymarket tag={tag} fetch failed: {e}')

    # Deduplicate by question
    seen = set()
    deduped = []
    for m in all_markets:
        q_key = m['question'].lower().strip()
        if q_key not in seen:
            seen.add(q_key)
            deduped.append(m)

    # Sort by volume descending
    deduped.sort(key=lambda x: x['volume'], reverse=True)

    if deduped:
        with _poly_lock:
            _poly_cache['data'] = deduped
            _poly_cache['ts'] = time.time()
        cache_set(redis_key, deduped, _POLY_CACHE_TTL)
        logger.warning(f'Polymarket fetched {len(deduped)} prediction markets')
    else:
        logger.warning(f'Polymarket fetch returned 0 markets from {len(POLY_TAGS)} tags (all_markets={len(all_markets)})')
        with _poly_lock:
            return _poly_cache['data'] or []

    return deduped


# ── Unified Context Builder ─────────────────────────────────────────────────

def build_global_data_context(user_id: str, profile: dict = None, max_rss: int = 50,
                              max_duration: float = 30.0) -> str:
    """Build formatted international data context text for AI prompt injection.

    Returns a multi-section text block covering:
      - Global financial market indices
      - International news headlines (RSS)
      - Prediction market signals (Polymarket)

    Enforces a time budget (max_duration seconds) — skips remaining sections if exceeded.
    """
    deadline = time.time() + max_duration
    sections = []

    # 1. Global indices (parallelized, fast)
    try:
        indices = fetch_global_indices()
        if indices:
            lines = []
            for sym, info in indices.items():
                arrow = '▲' if info['change'] > 0 else '▼' if info['change'] < 0 else '─'
                color_hint = '+' if info['change'] > 0 else ''
                lines.append(
                    f"  {info['name']}: {info['price']} ({color_hint}{info['change']}, "
                    f"{color_hint}{info['changePct']:.2f}%) {arrow}"
                )
            sections.append('全球金融市场:\n' + '\n'.join(lines))
    except Exception as e:
        logger.debug(f'Global indices context failed: {e}')

    if time.time() > deadline:
        return '\n\n'.join(sections)

    # 2. RSS news
    try:
        rss_items = fetch_rss_news()
        if rss_items:
            # If profile provided, boost relevance by keyword matching
            if profile:
                industries = profile.get('industries', [])
                keywords = []
                for ind in industries:
                    from services.global_signals import INDUSTRY_GLOBAL_KEYWORDS
                    keywords.extend(INDUSTRY_GLOBAL_KEYWORDS.get(ind, []))
                keywords.extend(k.lower() for k in profile.get('tracked_keywords', []))

                if keywords:
                    for item in rss_items:
                        title_lower = item['title'].lower()
                        item['_boost'] = sum(1 for kw in keywords if kw in title_lower)
                    rss_items = sorted(rss_items, key=lambda x: x.get('_boost', 0), reverse=True)

            items = rss_items[:max_rss]
            lines = [f"  - [{it['source']}] {it['title']}" for it in items]
            sections.append(f'国际新闻动态({len(items)}条):\n' + '\n'.join(lines))
    except Exception as e:
        logger.debug(f'RSS news context failed: {e}')

    if time.time() > deadline:
        return '\n\n'.join(sections)

    # 3. Polymarket
    try:
        markets = fetch_polymarket()
        if markets:
            lines = []
            for m in markets[:8]:
                lines.append(
                    f"  - [{m['tag']}] {m['question']} → 概率{m['probability']}% "
                    f"(交易量${m['volume']:,.0f})"
                )
            sections.append(f'预测市场信号({len(lines)}条):\n' + '\n'.join(lines))
    except Exception as e:
        logger.debug(f'Polymarket context failed: {e}')

    result = '\n\n'.join(sections)
    if sections:
        logger.warning(f'Global data context: {len(sections)} sections, {len(result)} chars')
    return result
