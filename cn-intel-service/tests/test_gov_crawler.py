"""Tests for gov_news_crawler core functions: _safe_get, _record_health, _fetch_source."""

import sys
import os
import types
from unittest.mock import patch, MagicMock

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Stub heavy optional deps before importing the module
_cache_store = {}


def _fake_cache_get(key):
    return _cache_store.get(key)


def _fake_cache_set(key, val, ttl=None):
    _cache_store[key] = val


# Pre-create stub modules so gov_news_crawler can import without Redis/MySQL
_cache_mod = types.ModuleType('services.cache')
_cache_mod.cache_get = _fake_cache_get
_cache_mod.cache_set = _fake_cache_set
sys.modules.setdefault('services.cache', _cache_mod)

_config_mod = types.ModuleType('config')


class _FakeConfig:
    MYSQL_HOST = ''
    MYSQL_PORT = 3306
    MYSQL_USER = ''
    MYSQL_PASSWORD = ''
    MYSQL_DATABASE = ''


_config_mod.Config = _FakeConfig
sys.modules.setdefault('config', _config_mod)

_db_mod = types.ModuleType('services.db_pool')
_db_mod.get_connection = MagicMock()
sys.modules.setdefault('services.db_pool', _db_mod)

_entity_mod = types.ModuleType('services.cn_entity_registry')
_entity_mod.find_entities_in_text = lambda *a, **kw: []
sys.modules.setdefault('services.cn_entity_registry', _entity_mod)


# ── Tests ──────────────────────────────────────────────────────────────────


class TestSafeGet:
    """Test _safe_get retry logic."""

    def test_success_first_try(self):
        from services.gov_news_crawler import _safe_get

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.apparent_encoding = 'utf-8'

        with patch('services.gov_news_crawler.requests.get', return_value=mock_resp) as mock_get:
            result = _safe_get('http://example.com', retries=2)
            assert result is mock_resp
            assert mock_get.call_count == 1

    def test_retry_on_failure(self):
        from services.gov_news_crawler import _safe_get

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.apparent_encoding = 'utf-8'

        with patch('services.gov_news_crawler.requests.get',
                   side_effect=[Exception('timeout'), Exception('timeout'), mock_resp]) as mock_get:
            with patch('time.sleep'):
                result = _safe_get('http://example.com', retries=2)
                assert result is mock_resp
                assert mock_get.call_count == 3

    def test_all_retries_fail(self):
        from services.gov_news_crawler import _safe_get

        with patch('services.gov_news_crawler.requests.get',
                   side_effect=Exception('always fail')):
            with patch('time.sleep'):
                result = _safe_get('http://example.com', retries=1)
                assert result is None

    def test_encoding_override(self):
        from services.gov_news_crawler import _safe_get

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.apparent_encoding = 'gbk'

        with patch('services.gov_news_crawler.requests.get', return_value=mock_resp):
            result = _safe_get('http://example.com', encoding='utf-8')
            assert result.encoding == 'utf-8'

    def test_gov_cn_default_encoding(self):
        from services.gov_news_crawler import _safe_get

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.apparent_encoding = None

        with patch('services.gov_news_crawler.requests.get', return_value=mock_resp):
            result = _safe_get('http://www.mof.gov.cn/news')
            assert result.encoding == 'utf-8'


class TestRecordHealth:
    """Test _record_health writes to cache."""

    def test_record_success(self):
        _cache_store.clear()
        from services.gov_news_crawler import _record_health

        _record_health('people', 5)
        data = _cache_store.get('cn:health:people')
        assert data is not None
        assert data['count'] == 5
        assert 'error' not in data

    def test_record_error(self):
        _cache_store.clear()
        from services.gov_news_crawler import _record_health

        _record_health('xinhua', 0, error=Exception('Connection refused'))
        data = _cache_store.get('cn:health:xinhua')
        assert data is not None
        assert data['count'] == 0
        assert 'Connection refused' in data['error']


class TestFetchSource:
    """Test _fetch_source dispatches to fetcher and records health."""

    def test_unknown_key(self):
        from services.gov_news_crawler import _fetch_source

        key, items = _fetch_source('nonexistent_source_xyz')
        assert key == 'nonexistent_source_xyz'
        assert items == []

    def test_fetcher_success(self):
        from services import gov_news_crawler

        mock_items = [{'title': 'Test', 'url': 'http://t.cn'}]
        fake_fetcher = MagicMock(return_value=mock_items)
        original = gov_news_crawler._FETCHERS.copy()

        try:
            gov_news_crawler._FETCHERS['_test_src'] = fake_fetcher
            _cache_store.clear()
            key, items = gov_news_crawler._fetch_source('_test_src')
            assert key == '_test_src'
            assert items == mock_items
            assert _cache_store.get('cn:health:_test_src', {}).get('count') == 1
        finally:
            gov_news_crawler._FETCHERS = original

    def test_fetcher_exception(self):
        from services import gov_news_crawler

        fake_fetcher = MagicMock(side_effect=Exception('crash'))
        original = gov_news_crawler._FETCHERS.copy()

        try:
            gov_news_crawler._FETCHERS['_test_err'] = fake_fetcher
            _cache_store.clear()
            key, items = gov_news_crawler._fetch_source('_test_err')
            assert key == '_test_err'
            assert items == []
            health = _cache_store.get('cn:health:_test_err', {})
            assert health.get('count') == 0
            assert 'crash' in health.get('error', '')
        finally:
            gov_news_crawler._FETCHERS = original


class TestGovSources:
    """Test GOV_SOURCES registry integrity."""

    def test_all_sources_have_required_fields(self):
        from services.gov_news_crawler import GOV_SOURCES

        for key, src in GOV_SOURCES.items():
            assert 'name' in src, f'{key} missing name'
            assert 'category' in src, f'{key} missing category'
            assert 'url' in src, f'{key} missing url'
