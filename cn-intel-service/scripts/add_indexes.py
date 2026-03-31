#!/usr/bin/env python3
"""Add performance indexes to cn-intel-service MySQL tables.

Safe to run multiple times — checks for existing indexes before adding.
Run from the project root:
    python scripts/add_indexes.py
"""

import os
import sys
import pymysql

# Allow running from project root or scripts/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from config import Config


INDEXES = [
    # (table, index_name, columns)
    # P0: Critical — affects every request
    ('wm_sessions', 'idx_account_id', 'account_id'),
    ('wm_sessions', 'idx_expires_at', 'expires_at'),

    # P1: High — admin filtering, VIP expiry
    ('wm_accounts', 'idx_status_role', 'status, role'),
    ('wm_accounts', 'idx_expires_at', 'expires_at'),

    # P1: High — alert scanning with date + source/category filters
    ('policy_news', 'idx_news_date_source', 'news_date, source_key'),
    ('policy_news', 'idx_news_date_category', 'news_date, category'),

    # P1: High — report history pagination
    ('report_archives', 'idx_user_created', 'user_id, created_at DESC'),
    ('report_archives', 'idx_type_generated', 'report_type, generated_at DESC'),

    # P2: Medium — profile iteration, snapshot audit trail
    ('user_profiles', 'idx_created_at', 'created_at DESC'),
    ('user_snapshots', 'idx_user_created_desc', 'user_id, created_at DESC'),
]


def table_exists(cursor, table):
    cursor.execute("SHOW TABLES LIKE %s", (table,))
    return cursor.fetchone() is not None


def index_exists(cursor, table, index_name):
    cursor.execute("SHOW INDEX FROM `%s` WHERE Key_name = %%s" % table, (index_name,))
    return cursor.fetchone() is not None


def main():
    conn = pymysql.connect(
        host=Config.MYSQL_HOST,
        port=Config.MYSQL_PORT,
        user=Config.MYSQL_USER,
        password=Config.MYSQL_PASSWORD,
        database=Config.MYSQL_DATABASE,
        charset='utf8mb4',
    )
    cursor = conn.cursor()
    added = 0
    skipped = 0

    for table, idx_name, columns in INDEXES:
        if not table_exists(cursor, table):
            print(f'  SKIP  {table}.{idx_name} — table does not exist')
            skipped += 1
            continue
        if index_exists(cursor, table, idx_name):
            print(f'  SKIP  {table}.{idx_name} — index already exists')
            skipped += 1
            continue
        sql = f'ALTER TABLE `{table}` ADD INDEX `{idx_name}` ({columns})'
        print(f'  ADD   {table}.{idx_name} ({columns})')
        cursor.execute(sql)
        added += 1

    conn.commit()
    cursor.close()
    conn.close()
    print(f'\nDone: {added} indexes added, {skipped} skipped.')


if __name__ == '__main__':
    main()
