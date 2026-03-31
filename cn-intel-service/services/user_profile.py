"""User profile management for personalized intelligence.
Users declare industries, sectors, stocks, and keywords to receive
filtered and ranked policy/sentiment information.

Table: user_profiles
  id             BIGINT AUTO_INCREMENT PK
  user_id        VARCHAR(64) UNIQUE    -- client-generated UUID
  company_name   VARCHAR(128)          -- enterprise name
  company_size   VARCHAR(32)           -- 微型/小型/中型/大型/集团
  business_scope TEXT                   -- JSON: 主营业务描述(自由文本)
  industries     TEXT                   -- JSON string e.g. ["新能源","半导体"]
  tracked_sectors TEXT                  -- JSON string e.g. ["光伏","芯片"]
  tracked_stocks TEXT                   -- JSON string (deprecated, kept for compat)
  tracked_keywords TEXT                 -- JSON string e.g. ["降息","碳中和"]
  supply_chain_up TEXT                  -- JSON: 上游供应链 ["芯片","稀土"]
  supply_chain_down TEXT                -- JSON: 下游客户/渠道 ["汽车OEM","消费电子"]
  competitors    TEXT                   -- JSON: 竞争对手 ["比亚迪","宁德时代"]
  compliance_concerns TEXT              -- JSON: 合规关注点 ["数据安全","ESG"]
  business_regions TEXT                 -- JSON: 经营区域 ["长三角","珠三角"]
  report_frequency VARCHAR(32)          -- daily/weekly/monthly (默认weekly)
  alert_min_score INT DEFAULT 60       -- minimum policy score for alerts
  last_seen_at   DATETIME             -- heartbeat timestamp
  created_at     DATETIME DEFAULT NOW()
  updated_at     DATETIME DEFAULT NOW()
"""

import json
import logging
from datetime import datetime
from contextlib import contextmanager

logger = logging.getLogger('cn-intel.user-profile')

_TABLE_CREATED = False

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS user_profiles (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    company_name    VARCHAR(128) DEFAULT '',
    industries      TEXT,
    tracked_sectors TEXT,
    tracked_stocks  TEXT,
    tracked_keywords TEXT,
    alert_min_score INT NOT NULL DEFAULT 60,
    last_seen_at    DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""

# New columns added in Session 43 — ALTER TABLE is safe to run multiple times
_ALTER_TABLE_SQLS = [
    "ALTER TABLE user_profiles ADD COLUMN company_size VARCHAR(32) DEFAULT '' AFTER company_name",
    "ALTER TABLE user_profiles ADD COLUMN business_scope TEXT AFTER company_size",
    "ALTER TABLE user_profiles ADD COLUMN supply_chain_up TEXT AFTER tracked_keywords",
    "ALTER TABLE user_profiles ADD COLUMN supply_chain_down TEXT AFTER supply_chain_up",
    "ALTER TABLE user_profiles ADD COLUMN competitors TEXT AFTER supply_chain_down",
    "ALTER TABLE user_profiles ADD COLUMN compliance_concerns TEXT AFTER competitors",
    "ALTER TABLE user_profiles ADD COLUMN business_regions TEXT AFTER compliance_concerns",
    "ALTER TABLE user_profiles ADD COLUMN report_frequency VARCHAR(32) DEFAULT 'weekly' AFTER business_regions",
    "ALTER TABLE user_profiles ADD COLUMN ai_provider_order TEXT AFTER report_frequency",
    "ALTER TABLE user_profiles ADD COLUMN ai_custom_keys TEXT AFTER ai_provider_order",
    # Session 48: new enrichment columns
    "ALTER TABLE user_profiles ADD COLUMN key_products TEXT AFTER business_scope",
    "ALTER TABLE user_profiles ADD COLUMN focus_policy_areas TEXT AFTER business_regions",
    "ALTER TABLE user_profiles ADD COLUMN exclude_keywords TEXT AFTER tracked_keywords",
]

# Industry → sector mapping (for automatic sector expansion)
INDUSTRY_TO_SECTORS = {
    '新能源': ['光伏', '风电', '锂电池', '新能源车', '储能'],
    '半导体': ['半导体', '芯片', '集成电路'],
    'AI': ['AI', '人工智能', '大模型', '算力'],
    '生物医药': ['医药', '生物医药', '创新药', '医疗器械'],
    '新材料': ['新材料', '碳纤维', '稀土'],
    '高端装备': ['高端装备', '数控机床', '工业母机'],
    '汽车制造': ['汽车', '新能源车', '智能驾驶'],
    '消费电子': ['消费电子', '手机', '智能穿戴'],
    '金融科技': ['银行', '保险', '券商', '金融科技', 'Fintech'],
    '互联网': ['互联网', '电商', 'SaaS', '云计算'],
    '军工国防': ['军工', '国防', '航空航天'],
    '通信': ['通信', '5G', '光通信', '卫星'],
    '基建': ['基建', '水利', '交通'],
    '机器人': ['机器人', '工业自动化'],
    '环保': ['环保', '碳中和', '污水处理', '固废'],
    '化工': ['化工', '石化', '精细化工'],
}

AVAILABLE_INDUSTRIES = list(INDUSTRY_TO_SECTORS.keys())


@contextmanager
def _get_conn():
    from services.db_pool import get_connection
    conn = get_connection()
    try:
        yield conn
    finally:
        conn.close()


def _ensure_table():
    global _TABLE_CREATED
    if _TABLE_CREATED:
        return
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(_CREATE_TABLE_SQL)
                # Run ALTER TABLE migrations (idempotent — ignores "Duplicate column" errors)
                for sql in _ALTER_TABLE_SQLS:
                    try:
                        cur.execute(sql)
                    except Exception:
                        pass  # Column already exists
            conn.commit()
        _TABLE_CREATED = True
        logger.warning('[user-profile] Table user_profiles ensured (with new columns)')
    except Exception as e:
        logger.warning(f'[user-profile] Table creation error: {e}')


def get_profile(user_id: str) -> dict | None:
    """Get user profile by user_id. Returns dict or None."""
    _ensure_table()
    try:
        import pymysql
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute("SELECT * FROM user_profiles WHERE user_id=%s", (user_id,))
                row = cur.fetchone()
                if not row:
                    return None
                return _row_to_profile(row)
    except Exception as e:
        logger.warning(f'[user-profile] Get error: {e}')
        return None


def upsert_profile(user_id: str, data: dict) -> dict:
    """Create or update user profile. Returns the saved profile."""
    _ensure_table()
    company_name = data.get('company_name', '')
    company_size = data.get('company_size', '')
    business_scope = data.get('business_scope', '')
    key_products = json.dumps(data.get('key_products', []), ensure_ascii=False)
    industries = json.dumps(data.get('industries', []), ensure_ascii=False)
    tracked_sectors = json.dumps(data.get('tracked_sectors', []), ensure_ascii=False)
    tracked_stocks = json.dumps(data.get('tracked_stocks', []), ensure_ascii=False)
    tracked_keywords = json.dumps(data.get('tracked_keywords', []), ensure_ascii=False)
    exclude_keywords = json.dumps(data.get('exclude_keywords', []), ensure_ascii=False)
    supply_chain_up = json.dumps(data.get('supply_chain_up', []), ensure_ascii=False)
    supply_chain_down = json.dumps(data.get('supply_chain_down', []), ensure_ascii=False)
    competitors = json.dumps(data.get('competitors', []), ensure_ascii=False)
    compliance_concerns = json.dumps(data.get('compliance_concerns', []), ensure_ascii=False)
    business_regions = json.dumps(data.get('business_regions', []), ensure_ascii=False)
    focus_policy_areas = json.dumps(data.get('focus_policy_areas', []), ensure_ascii=False)
    report_frequency = data.get('report_frequency', 'weekly')
    ai_provider_order = json.dumps(data.get('ai_provider_order', []), ensure_ascii=False)
    ai_custom_keys = json.dumps(data.get('ai_custom_keys', {}), ensure_ascii=False)
    alert_min_score = data.get('alert_min_score', 60)
    now = datetime.now()

    sql = """INSERT INTO user_profiles
        (user_id, company_name, company_size, business_scope, key_products,
         industries, tracked_sectors, tracked_stocks, tracked_keywords, exclude_keywords,
         supply_chain_up, supply_chain_down, competitors,
         compliance_concerns, business_regions, focus_policy_areas,
         report_frequency, ai_provider_order, ai_custom_keys, alert_min_score,
         last_seen_at, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            company_name=VALUES(company_name),
            company_size=VALUES(company_size),
            business_scope=VALUES(business_scope),
            key_products=VALUES(key_products),
            industries=VALUES(industries),
            tracked_sectors=VALUES(tracked_sectors),
            tracked_stocks=VALUES(tracked_stocks),
            tracked_keywords=VALUES(tracked_keywords),
            exclude_keywords=VALUES(exclude_keywords),
            supply_chain_up=VALUES(supply_chain_up),
            supply_chain_down=VALUES(supply_chain_down),
            competitors=VALUES(competitors),
            compliance_concerns=VALUES(compliance_concerns),
            business_regions=VALUES(business_regions),
            focus_policy_areas=VALUES(focus_policy_areas),
            report_frequency=VALUES(report_frequency),
            ai_provider_order=VALUES(ai_provider_order),
            ai_custom_keys=VALUES(ai_custom_keys),
            alert_min_score=VALUES(alert_min_score),
            updated_at=VALUES(updated_at)
    """
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (
                    user_id, company_name, company_size, business_scope, key_products,
                    industries, tracked_sectors, tracked_stocks, tracked_keywords, exclude_keywords,
                    supply_chain_up, supply_chain_down, competitors,
                    compliance_concerns, business_regions, focus_policy_areas,
                    report_frequency, ai_provider_order, ai_custom_keys, alert_min_score, now, now, now
                ))
            conn.commit()
        logger.warning(f'[user-profile] Upserted profile for {user_id[:8]}...')
    except Exception as e:
        logger.warning(f'[user-profile] Upsert error: {e}')

    return get_profile(user_id) or {'user_id': user_id}


def update_last_seen(user_id: str):
    """Update heartbeat timestamp."""
    _ensure_table()
    try:
        with _get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE user_profiles SET last_seen_at=%s WHERE user_id=%s",
                    (datetime.now(), user_id))
            conn.commit()
    except Exception as e:
        logger.warning(f'[user-profile] Heartbeat error: {e}')


def get_all_profiles() -> list:
    """Get all user profiles (for batch alert evaluation)."""
    _ensure_table()
    try:
        import pymysql
        with _get_conn() as conn:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute("SELECT * FROM user_profiles")
                return [_row_to_profile(r) for r in cur.fetchall()]
    except Exception as e:
        logger.warning(f'[user-profile] Get all error: {e}')
        return []


def get_expanded_sectors(profile: dict) -> list:
    """Expand industries into full sector list, merged with explicit tracked_sectors."""
    sectors = set(profile.get('tracked_sectors', []))
    for ind in profile.get('industries', []):
        for s in INDUSTRY_TO_SECTORS.get(ind, []):
            sectors.add(s)
    return list(sectors)


def _row_to_profile(row: dict) -> dict:
    """Convert DB row to standardized profile dict."""
    def _parse_json(val):
        if val is None:
            return []
        if isinstance(val, list):
            return val
        if isinstance(val, str):
            try:
                return json.loads(val)
            except Exception:
                return []
        return []

    def _parse_json_dict(val):
        if val is None:
            return {}
        if isinstance(val, dict):
            return val
        if isinstance(val, str):
            try:
                result = json.loads(val)
                return result if isinstance(result, dict) else {}
            except Exception:
                return {}
        return {}

    return {
        'user_id': row.get('user_id', ''),
        'company_name': row.get('company_name', ''),
        'company_size': row.get('company_size', ''),
        'business_scope': row.get('business_scope', ''),
        'key_products': _parse_json(row.get('key_products')),
        'industries': _parse_json(row.get('industries')),
        'tracked_sectors': _parse_json(row.get('tracked_sectors')),
        'tracked_stocks': _parse_json(row.get('tracked_stocks')),
        'tracked_keywords': _parse_json(row.get('tracked_keywords')),
        'exclude_keywords': _parse_json(row.get('exclude_keywords')),
        'supply_chain_up': _parse_json(row.get('supply_chain_up')),
        'supply_chain_down': _parse_json(row.get('supply_chain_down')),
        'competitors': _parse_json(row.get('competitors')),
        'compliance_concerns': _parse_json(row.get('compliance_concerns')),
        'business_regions': _parse_json(row.get('business_regions')),
        'focus_policy_areas': _parse_json(row.get('focus_policy_areas')),
        'report_frequency': row.get('report_frequency', 'weekly'),
        'ai_provider_order': _parse_json(row.get('ai_provider_order')),
        'ai_custom_keys': _parse_json_dict(row.get('ai_custom_keys')),
        'alert_min_score': row.get('alert_min_score', 60),
        'last_seen_at': row['last_seen_at'].isoformat() if row.get('last_seen_at') else None,
        'created_at': row['created_at'].isoformat() if row.get('created_at') else None,
        'updated_at': row['updated_at'].isoformat() if row.get('updated_at') else None,
    }
