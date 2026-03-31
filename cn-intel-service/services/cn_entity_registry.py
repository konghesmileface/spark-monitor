"""A-share entity registry: stocks, indices, sectors, policy bodies.
Provides multi-dimensional lookup for entity extraction, knowledge graph,
and co-occurrence analysis across the World Monitor system.

Replaces Phase 1.4's simple _STOCK_ALIASES dict with a richer entity model."""

import re
import logging

logger = logging.getLogger('cn-intel.entity')

# Entity types
TYPE_STOCK = 'stock'
TYPE_INDEX = 'index'
TYPE_SECTOR = 'sector'
TYPE_POLICY_BODY = 'policy_body'

# ── Entity definitions ──────────────────────────────────────────────────────

_ENTITIES = [
    # ═══ Indices ═══
    {'id': 'idx_sh', 'type': TYPE_INDEX, 'name': '上证指数', 'aliases': ['上证', '大盘', '沪指', '上证综指'], 'sector': '指数', 'code': '000001.SH'},
    {'id': 'idx_sz', 'type': TYPE_INDEX, 'name': '深证成指', 'aliases': ['深证', '深指', '深成指'], 'sector': '指数', 'code': '399001.SZ'},
    {'id': 'idx_cyb', 'type': TYPE_INDEX, 'name': '创业板指', 'aliases': ['创业板', '创指'], 'sector': '指数', 'code': '399006.SZ'},
    {'id': 'idx_kc50', 'type': TYPE_INDEX, 'name': '科创50', 'aliases': ['科创', '科创板'], 'sector': '指数', 'code': '000688.SH'},
    {'id': 'idx_hs300', 'type': TYPE_INDEX, 'name': '沪深300', 'aliases': ['300', 'HS300'], 'sector': '指数', 'code': '000300.SH'},
    {'id': 'idx_zz500', 'type': TYPE_INDEX, 'name': '中证500', 'aliases': ['500', 'ZZ500'], 'sector': '指数', 'code': '000905.SH'},
    {'id': 'idx_zz1000', 'type': TYPE_INDEX, 'name': '中证1000', 'aliases': ['1000'], 'sector': '指数', 'code': '000852.SH'},

    # ═══ Policy Bodies ═══
    {'id': 'pb_pboc', 'type': TYPE_POLICY_BODY, 'name': '中国人民银行', 'aliases': ['央行', '人民银行', 'PBOC'], 'sector': '政策', 'keywords': ['降息', '降准', '利率', 'LPR', 'MLF', '逆回购', '货币政策']},
    {'id': 'pb_csrc', 'type': TYPE_POLICY_BODY, 'name': '中国证监会', 'aliases': ['证监会', 'CSRC'], 'sector': '政策', 'keywords': ['IPO', '注册制', '退市', '减持', '证券监管']},
    {'id': 'pb_cbirc', 'type': TYPE_POLICY_BODY, 'name': '国家金融监管总局', 'aliases': ['金监总局', '银保监', 'CBIRC'], 'sector': '政策', 'keywords': ['银行监管', '保险监管']},
    {'id': 'pb_mof', 'type': TYPE_POLICY_BODY, 'name': '财政部', 'aliases': ['财政'], 'sector': '政策', 'keywords': ['财政', '国债', '专项债', '税收', '减税']},
    {'id': 'pb_ndrc', 'type': TYPE_POLICY_BODY, 'name': '国家发改委', 'aliases': ['发改委', 'NDRC'], 'sector': '政策', 'keywords': ['发展改革', '价格', '投资', '审批']},
    {'id': 'pb_sc', 'type': TYPE_POLICY_BODY, 'name': '国务院', 'aliases': ['国常会', '国办'], 'sector': '政策', 'keywords': ['国务院常务会议', '政府工作报告']},
    {'id': 'pb_miit', 'type': TYPE_POLICY_BODY, 'name': '工信部', 'aliases': ['工业和信息化部'], 'sector': '政策', 'keywords': ['产业政策', '制造业', '新能源汽车']},
    {'id': 'pb_most', 'type': TYPE_POLICY_BODY, 'name': '科技部', 'aliases': [], 'sector': '政策', 'keywords': ['科技创新', '基础研究']},
    {'id': 'pb_safe', 'type': TYPE_POLICY_BODY, 'name': '国家外汇管理局', 'aliases': ['外汇局', 'SAFE'], 'sector': '政策', 'keywords': ['外汇', '汇率', '外储']},
    {'id': 'pb_fed', 'type': TYPE_POLICY_BODY, 'name': '美联储', 'aliases': ['Fed', 'Federal Reserve', '联储'], 'sector': '国际', 'keywords': ['加息', '缩表', 'QE', '联邦基金利率']},
    {'id': 'pb_ecb', 'type': TYPE_POLICY_BODY, 'name': '欧央行', 'aliases': ['ECB', '欧洲央行'], 'sector': '国际', 'keywords': ['欧元区利率']},
    {'id': 'pb_boj', 'type': TYPE_POLICY_BODY, 'name': '日本央行', 'aliases': ['BOJ', '日银'], 'sector': '国际', 'keywords': ['YCC', '日元']},

    # ═══ Sectors ═══
    {'id': 'sec_baijiu', 'type': TYPE_SECTOR, 'name': '白酒', 'aliases': ['白酒板块', '酿酒'], 'sector': '消费', 'keywords': ['白酒', '酿酒', '高端白酒']},
    {'id': 'sec_bank', 'type': TYPE_SECTOR, 'name': '银行', 'aliases': ['银行板块', '银行股'], 'sector': '金融', 'keywords': ['银行', '信贷', '存款']},
    {'id': 'sec_insurance', 'type': TYPE_SECTOR, 'name': '保险', 'aliases': ['保险板块'], 'sector': '金融', 'keywords': ['保险', '寿险', '财险']},
    {'id': 'sec_broker', 'type': TYPE_SECTOR, 'name': '券商', 'aliases': ['券商板块', '证券'], 'sector': '金融', 'keywords': ['券商', '证券', '投行']},
    {'id': 'sec_semi', 'type': TYPE_SECTOR, 'name': '半导体', 'aliases': ['芯片', '集成电路', '半导体板块'], 'sector': '科技', 'keywords': ['半导体', '芯片', '光刻', '晶圆', 'EDA']},
    {'id': 'sec_ai', 'type': TYPE_SECTOR, 'name': 'AI', 'aliases': ['人工智能', 'AI板块', '大模型'], 'sector': '科技', 'keywords': ['AI', '大模型', '算力', 'GPT', '智能']},
    {'id': 'sec_nev', 'type': TYPE_SECTOR, 'name': '新能源车', 'aliases': ['新能源汽车', '电动车', 'NEV'], 'sector': '新能源', 'keywords': ['新能源车', '电动车', '充电桩', '锂电']},
    {'id': 'sec_solar', 'type': TYPE_SECTOR, 'name': '光伏', 'aliases': ['光伏板块', '太阳能'], 'sector': '新能源', 'keywords': ['光伏', '硅片', '组件', '逆变器']},
    {'id': 'sec_wind', 'type': TYPE_SECTOR, 'name': '风电', 'aliases': ['风电板块', '风力发电'], 'sector': '新能源', 'keywords': ['风电', '风机', '海上风电']},
    {'id': 'sec_battery', 'type': TYPE_SECTOR, 'name': '锂电池', 'aliases': ['锂电', '动力电池', '储能'], 'sector': '新能源', 'keywords': ['锂电池', '电解液', '正极', '负极', '隔膜']},
    {'id': 'sec_pharma', 'type': TYPE_SECTOR, 'name': '医药', 'aliases': ['医药板块', '生物医药', '创新药'], 'sector': '医疗', 'keywords': ['医药', '创新药', '中药', 'CXO', '医疗器械']},
    {'id': 'sec_realestate', 'type': TYPE_SECTOR, 'name': '房地产', 'aliases': ['地产', '房产', '楼市'], 'sector': '地产', 'keywords': ['房地产', '楼市', '房价', '土拍', '保交楼']},
    {'id': 'sec_military', 'type': TYPE_SECTOR, 'name': '军工', 'aliases': ['国防军工', '军工板块'], 'sector': '军工', 'keywords': ['军工', '国防', '航空', '导弹', '军舰']},
    {'id': 'sec_consumer', 'type': TYPE_SECTOR, 'name': '消费', 'aliases': ['大消费', '消费板块'], 'sector': '消费', 'keywords': ['消费', '零售', '食品', '家电']},
    {'id': 'sec_infra', 'type': TYPE_SECTOR, 'name': '基建', 'aliases': ['基建板块', '新基建'], 'sector': '基建', 'keywords': ['基建', '铁路', '公路', '水利']},
    {'id': 'sec_telecom', 'type': TYPE_SECTOR, 'name': '通信', 'aliases': ['通信板块', '5G', '6G'], 'sector': '科技', 'keywords': ['5G', '6G', '通信', '光纤', '基站']},
    {'id': 'sec_robot', 'type': TYPE_SECTOR, 'name': '机器人', 'aliases': ['人形机器人', '机器人板块'], 'sector': '科技', 'keywords': ['机器人', '人形', '减速器', '伺服']},

    # ═══ Stocks (A-share top ~80 by market cap) ═══
    # White liquor
    {'id': 's_600519', 'type': TYPE_STOCK, 'name': '贵州茅台', 'aliases': ['茅台', '贵茅', 'MOUTAI', '茅子'], 'sector': '白酒', 'code': '600519'},
    {'id': 's_000858', 'type': TYPE_STOCK, 'name': '五粮液', 'aliases': ['五粮'], 'sector': '白酒', 'code': '000858'},
    {'id': 's_000568', 'type': TYPE_STOCK, 'name': '泸州老窖', 'aliases': ['老窖', '泸州'], 'sector': '白酒', 'code': '000568'},
    {'id': 's_600809', 'type': TYPE_STOCK, 'name': '山西汾酒', 'aliases': ['汾酒'], 'sector': '白酒', 'code': '600809'},
    # Banks
    {'id': 's_600036', 'type': TYPE_STOCK, 'name': '招商银行', 'aliases': ['招行', '招银'], 'sector': '银行', 'code': '600036'},
    {'id': 's_601398', 'type': TYPE_STOCK, 'name': '工商银行', 'aliases': ['工行', '宇宙行'], 'sector': '银行', 'code': '601398'},
    {'id': 's_601939', 'type': TYPE_STOCK, 'name': '建设银行', 'aliases': ['建行'], 'sector': '银行', 'code': '601939'},
    {'id': 's_601988', 'type': TYPE_STOCK, 'name': '中国银行', 'aliases': ['中行'], 'sector': '银行', 'code': '601988'},
    {'id': 's_601288', 'type': TYPE_STOCK, 'name': '农业银行', 'aliases': ['农行'], 'sector': '银行', 'code': '601288'},
    {'id': 's_601166', 'type': TYPE_STOCK, 'name': '兴业银行', 'aliases': ['兴业'], 'sector': '银行', 'code': '601166'},
    {'id': 's_000001', 'type': TYPE_STOCK, 'name': '平安银行', 'aliases': ['平银'], 'sector': '银行', 'code': '000001'},
    # Insurance
    {'id': 's_601318', 'type': TYPE_STOCK, 'name': '中国平安', 'aliases': ['平安', '中平'], 'sector': '保险', 'code': '601318'},
    {'id': 's_601628', 'type': TYPE_STOCK, 'name': '中国人寿', 'aliases': ['人寿', '国寿'], 'sector': '保险', 'code': '601628'},
    {'id': 's_601601', 'type': TYPE_STOCK, 'name': '中国太保', 'aliases': ['太保'], 'sector': '保险', 'code': '601601'},
    # Brokers
    {'id': 's_600030', 'type': TYPE_STOCK, 'name': '中信证券', 'aliases': ['中信', '中信券商'], 'sector': '券商', 'code': '600030'},
    {'id': 's_601688', 'type': TYPE_STOCK, 'name': '华泰证券', 'aliases': ['华泰'], 'sector': '券商', 'code': '601688'},
    {'id': 's_601211', 'type': TYPE_STOCK, 'name': '国泰君安', 'aliases': ['国君'], 'sector': '券商', 'code': '601211'},
    {'id': 's_300059', 'type': TYPE_STOCK, 'name': '东方财富', 'aliases': ['东财'], 'sector': '券商', 'code': '300059'},
    # Tech — NEV/Battery
    {'id': 's_300750', 'type': TYPE_STOCK, 'name': '宁德时代', 'aliases': ['宁德', 'CATL', '宁王'], 'sector': '锂电池', 'code': '300750'},
    {'id': 's_002594', 'type': TYPE_STOCK, 'name': '比亚迪', 'aliases': ['BYD', '迪子', '迪王'], 'sector': '新能源车', 'code': '002594'},
    {'id': 's_601012', 'type': TYPE_STOCK, 'name': '隆基绿能', 'aliases': ['隆基', '隆基股份'], 'sector': '光伏', 'code': '601012'},
    {'id': 's_600438', 'type': TYPE_STOCK, 'name': '通威股份', 'aliases': ['通威'], 'sector': '光伏', 'code': '600438'},
    {'id': 's_300274', 'type': TYPE_STOCK, 'name': '阳光电源', 'aliases': ['阳光'], 'sector': '光伏', 'code': '300274'},
    # Tech — Semiconductor
    {'id': 's_688981', 'type': TYPE_STOCK, 'name': '中芯国际', 'aliases': ['中芯', 'SMIC'], 'sector': '半导体', 'code': '688981'},
    {'id': 's_603501', 'type': TYPE_STOCK, 'name': '韦尔股份', 'aliases': ['韦尔'], 'sector': '半导体', 'code': '603501'},
    {'id': 's_002371', 'type': TYPE_STOCK, 'name': '北方华创', 'aliases': ['华创', '北华创'], 'sector': '半导体', 'code': '002371'},
    {'id': 's_688041', 'type': TYPE_STOCK, 'name': '海光信息', 'aliases': ['海光'], 'sector': '半导体', 'code': '688041'},
    {'id': 's_688012', 'type': TYPE_STOCK, 'name': '中微公司', 'aliases': ['中微'], 'sector': '半导体', 'code': '688012'},
    {'id': 's_688256', 'type': TYPE_STOCK, 'name': '寒武纪', 'aliases': ['寒武'], 'sector': 'AI', 'code': '688256'},
    # Tech — AI/Software
    {'id': 's_002230', 'type': TYPE_STOCK, 'name': '科大讯飞', 'aliases': ['讯飞'], 'sector': 'AI', 'code': '002230'},
    {'id': 's_000938', 'type': TYPE_STOCK, 'name': '紫光股份', 'aliases': ['紫光'], 'sector': '科技', 'code': '000938'},
    # Pharma
    {'id': 's_600276', 'type': TYPE_STOCK, 'name': '恒瑞医药', 'aliases': ['恒瑞'], 'sector': '医药', 'code': '600276'},
    {'id': 's_603259', 'type': TYPE_STOCK, 'name': '药明康德', 'aliases': ['药明', 'WuXi'], 'sector': '医药', 'code': '603259'},
    {'id': 's_300760', 'type': TYPE_STOCK, 'name': '迈瑞医疗', 'aliases': ['迈瑞'], 'sector': '医药', 'code': '300760'},
    {'id': 's_600436', 'type': TYPE_STOCK, 'name': '片仔癀', 'aliases': ['片仔'], 'sector': '医药', 'code': '600436'},
    # Consumer
    {'id': 's_600887', 'type': TYPE_STOCK, 'name': '伊利股份', 'aliases': ['伊利'], 'sector': '消费', 'code': '600887'},
    {'id': 's_603288', 'type': TYPE_STOCK, 'name': '海天味业', 'aliases': ['海天'], 'sector': '消费', 'code': '603288'},
    {'id': 's_000333', 'type': TYPE_STOCK, 'name': '美的集团', 'aliases': ['美的'], 'sector': '消费', 'code': '000333'},
    {'id': 's_000651', 'type': TYPE_STOCK, 'name': '格力电器', 'aliases': ['格力'], 'sector': '消费', 'code': '000651'},
    {'id': 's_600690', 'type': TYPE_STOCK, 'name': '海尔智家', 'aliases': ['海尔'], 'sector': '消费', 'code': '600690'},
    # Internet (HK-listed, commonly discussed)
    {'id': 's_00700', 'type': TYPE_STOCK, 'name': '腾讯控股', 'aliases': ['腾讯', 'Tencent'], 'sector': '互联网', 'code': '00700'},
    {'id': 's_09988', 'type': TYPE_STOCK, 'name': '阿里巴巴', 'aliases': ['阿里', '淘宝', 'Alibaba', 'BABA'], 'sector': '互联网', 'code': '09988'},
    {'id': 's_09888', 'type': TYPE_STOCK, 'name': '百度集团', 'aliases': ['百度', 'Baidu'], 'sector': '互联网', 'code': '09888'},
    {'id': 's_09618', 'type': TYPE_STOCK, 'name': '京东集团', 'aliases': ['京东', 'JD'], 'sector': '互联网', 'code': '09618'},
    {'id': 's_03690', 'type': TYPE_STOCK, 'name': '美团', 'aliases': ['美团点评'], 'sector': '互联网', 'code': '03690'},
    {'id': 's_01810', 'type': TYPE_STOCK, 'name': '小米集团', 'aliases': ['小米', 'Xiaomi'], 'sector': '互联网', 'code': '01810'},
    # Telecom
    {'id': 's_600941', 'type': TYPE_STOCK, 'name': '中国移动', 'aliases': ['移动'], 'sector': '通信', 'code': '600941'},
    {'id': 's_601728', 'type': TYPE_STOCK, 'name': '中国电信', 'aliases': ['电信'], 'sector': '通信', 'code': '601728'},
    {'id': 's_600050', 'type': TYPE_STOCK, 'name': '中国联通', 'aliases': ['联通'], 'sector': '通信', 'code': '600050'},
    {'id': 's_000063', 'type': TYPE_STOCK, 'name': '中兴通讯', 'aliases': ['中兴'], 'sector': '通信', 'code': '000063'},
    # Energy
    {'id': 's_601857', 'type': TYPE_STOCK, 'name': '中国石油', 'aliases': ['中石油', '两桶油'], 'sector': '能源', 'code': '601857'},
    {'id': 's_600028', 'type': TYPE_STOCK, 'name': '中国石化', 'aliases': ['中石化'], 'sector': '能源', 'code': '600028'},
    {'id': 's_601088', 'type': TYPE_STOCK, 'name': '中国神华', 'aliases': ['神华'], 'sector': '能源', 'code': '601088'},
    {'id': 's_601899', 'type': TYPE_STOCK, 'name': '紫金矿业', 'aliases': ['紫金'], 'sector': '资源', 'code': '601899'},
    {'id': 's_600900', 'type': TYPE_STOCK, 'name': '长江电力', 'aliases': ['长电'], 'sector': '能源', 'code': '600900'},
    # Military
    {'id': 's_600760', 'type': TYPE_STOCK, 'name': '中航沈飞', 'aliases': ['沈飞'], 'sector': '军工', 'code': '600760'},
    {'id': 's_600893', 'type': TYPE_STOCK, 'name': '航发动力', 'aliases': ['航发'], 'sector': '军工', 'code': '600893'},
    {'id': 's_600150', 'type': TYPE_STOCK, 'name': '中国船舶', 'aliases': ['船舶', '中船'], 'sector': '军工', 'code': '600150'},
    # Real estate
    {'id': 's_000002', 'type': TYPE_STOCK, 'name': '万科A', 'aliases': ['万科'], 'sector': '房地产', 'code': '000002'},
    {'id': 's_600048', 'type': TYPE_STOCK, 'name': '保利发展', 'aliases': ['保利'], 'sector': '房地产', 'code': '600048'},
    # Auto
    {'id': 's_601633', 'type': TYPE_STOCK, 'name': '长城汽车', 'aliases': ['长城'], 'sector': '汽车', 'code': '601633'},
    {'id': 's_000625', 'type': TYPE_STOCK, 'name': '长安汽车', 'aliases': ['长安'], 'sector': '汽车', 'code': '000625'},
    {'id': 's_600104', 'type': TYPE_STOCK, 'name': '上汽集团', 'aliases': ['上汽'], 'sector': '汽车', 'code': '600104'},
    # Infrastructure
    {'id': 's_601668', 'type': TYPE_STOCK, 'name': '中国建筑', 'aliases': ['中建'], 'sector': '基建', 'code': '601668'},
    {'id': 's_601390', 'type': TYPE_STOCK, 'name': '中国中铁', 'aliases': ['中铁'], 'sector': '基建', 'code': '601390'},
    {'id': 's_600585', 'type': TYPE_STOCK, 'name': '海螺水泥', 'aliases': ['海螺'], 'sector': '建材', 'code': '600585'},
]

# ── Build indices ────────────────────────────────────────────────────────────

_by_id = {}       # id → entity dict
_by_alias = {}    # alias (lowercase) → entity dict
_by_keyword = {}  # keyword → [entity dicts]
_by_sector = {}   # sector → [entity dicts]
_by_type = {}     # type → [entity dicts]

def _build_indices():
    """Build all lookup indices from _ENTITIES. Called at module load."""
    for e in _ENTITIES:
        eid = e['id']
        _by_id[eid] = e

        # Add name + aliases to alias index
        _by_alias[e['name'].lower()] = e
        _by_alias[e['name']] = e
        for alias in e.get('aliases', []):
            _by_alias[alias.lower()] = e
            _by_alias[alias] = e

        # Keywords
        for kw in e.get('keywords', []):
            _by_keyword.setdefault(kw, []).append(e)

        # Sector
        sector = e.get('sector', '')
        if sector:
            _by_sector.setdefault(sector, []).append(e)

        # Type
        _by_type.setdefault(e['type'], []).append(e)

_build_indices()


# ── Public API ───────────────────────────────────────────────────────────────

def find_entities_in_text(text, max_results=10):
    """Find all known entities mentioned in text.
    Returns list of entity dicts, deduplicated, max max_results."""
    if not text:
        return []
    found = {}
    # Check all aliases against text
    for alias, entity in _by_alias.items():
        if len(alias) < 2:
            continue  # Skip single-char aliases
        if alias in text and entity['id'] not in found:
            found[entity['id']] = entity
            if len(found) >= max_results:
                break
    return list(found.values())


def get_sectors_for_industry(industry: str) -> list:
    """Get sector entity names that belong to an industry theme.
    E.g., '新能源' → ['光伏', '风电', '锂电池', '新能源车']."""
    # Map industry themes to sector 'sector' field values
    theme_map = {
        '新能源': '新能源',
        '金融': '金融',
        '科技': '科技',
        '消费': '消费',
        '医疗': '医疗',
        '医药': '医疗',
        '地产': '地产',
        '房地产': '地产',
        '军工': '军工',
        '基建': '基建',
    }
    theme = theme_map.get(industry, industry)
    return [e['name'] for e in _ENTITIES
            if e.get('type') == TYPE_SECTOR and e.get('sector') == theme]


def find_related(entity_id, max_results=8):
    """Find entities related to the given entity.
    Relation: same sector, or keyword overlap."""
    entity = _by_id.get(entity_id)
    if not entity:
        return []

    related = {}
    # Same sector
    sector = entity.get('sector', '')
    if sector:
        for e in _by_sector.get(sector, []):
            if e['id'] != entity_id:
                related[e['id']] = e

    # Keyword overlap
    for kw in entity.get('keywords', []):
        for e in _by_keyword.get(kw, []):
            if e['id'] != entity_id:
                related[e['id']] = e

    return list(related.values())[:max_results]


def lookup_by_alias(name):
    """Look up entity by name or alias. Returns entity dict or None."""
    return _by_alias.get(name) or _by_alias.get(name.lower())


def lookup_by_keyword(keyword):
    """Find entities associated with a keyword. Returns list of entity dicts."""
    return _by_keyword.get(keyword, [])


def get_entities_by_type(entity_type):
    """Get all entities of a given type."""
    return _by_type.get(entity_type, [])


def get_entities_by_sector(sector):
    """Get all entities in a given sector."""
    return _by_sector.get(sector, [])


def get_all_sectors():
    """Return list of all sector names."""
    return list(_by_sector.keys())


def get_entity_count():
    """Return total number of registered entities."""
    return len(_ENTITIES)
