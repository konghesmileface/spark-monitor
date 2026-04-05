import json
import logging
import time
from collections import OrderedDict
from datetime import datetime
from functools import wraps
from flask import current_app

logger = logging.getLogger('cn-intel.cache')


def is_trading_time():
    """Check if current time is within A-share trading hours (weekday 9:15-15:05 CST)."""
    now = datetime.now()
    if now.weekday() >= 5:  # Saturday/Sunday
        return False
    t = now.hour * 100 + now.minute
    return 915 <= t <= 1505

# LRU memory cache with max size and TTL eviction
_MAX_CACHE_SIZE = 200
_memory_cache: OrderedDict = OrderedDict()
_memory_ttls: dict = {}


def _evict_expired():
    """Remove expired entries from memory cache."""
    now = time.time()
    expired = [k for k, t in _memory_ttls.items() if t < now]
    for k in expired:
        _memory_cache.pop(k, None)
        _memory_ttls.pop(k, None)


def get_redis():
    """Get raw Redis client from current app context. Returns None if unavailable."""
    try:
        return current_app.redis
    except Exception:
        return None


def cache_get(key):
    """Get from Redis (read-through to memory), fallback to memory cache."""
    r = current_app.redis
    if r:
        try:
            raw = r.get(key)
            if raw:
                val = json.loads(raw)
                # Read-through: populate memory cache so stale-while-revalidate works
                ttl_remaining = r.ttl(key)
                if ttl_remaining and ttl_remaining > 0:
                    _memory_cache[key] = val
                    _memory_ttls[key] = time.time() + ttl_remaining
                    _memory_cache.move_to_end(key)
                return val
        except Exception as e:
            logger.warning(f'Redis GET failed for {key}: {e}')
    # Memory fallback with TTL check
    ttl = _memory_ttls.get(key, 0)
    if ttl and ttl < time.time():
        _memory_cache.pop(key, None)
        _memory_ttls.pop(key, None)
        return None
    val = _memory_cache.get(key)
    if val is not None:
        _memory_cache.move_to_end(key)
    return val

def cache_get_stale(key):
    """Get stale data ignoring TTL — for graceful degradation during non-trading hours.
    Checks: memory cache (ignoring TTL) → Redis same key → Redis {key}:last (7-day copy)."""
    # 1. Memory cache (ignoring TTL)
    val = _memory_cache.get(key)
    if val is not None:
        return val
    # 2. Memory cache for :last key
    val = _memory_cache.get(f'{key}:last')
    if val is not None:
        return val
    # 3. Redis — try both keys
    r = get_redis()
    if r:
        try:
            raw = r.get(key)
            if raw:
                return json.loads(raw)
        except Exception:
            pass
        try:
            raw = r.get(f'{key}:last')
            if raw:
                return json.loads(raw)
        except Exception:
            pass
    return None


def cache_set_stale(key, value, ttl=604800):
    """Save a long-lived stale copy for fallback when live data fails.
    Uses {key}:last with 7-day TTL (default). Called after successful data fetch."""
    stale_key = f'{key}:last'
    # Memory cache
    _memory_cache[stale_key] = value
    _memory_ttls[stale_key] = time.time() + ttl
    _memory_cache.move_to_end(stale_key)
    # Redis
    r = get_redis()
    if r:
        try:
            r.setex(stale_key, ttl, json.dumps(value, ensure_ascii=False, default=str))
        except Exception as e:
            logger.warning(f'Redis SET stale failed for {stale_key}: {e}')


def cache_set(key, value, ttl=300):
    """Set in Redis with TTL, also in memory cache (LRU, max 200 entries)."""
    serialized = json.dumps(value, ensure_ascii=False, default=str)
    # Memory cache with LRU eviction
    _memory_cache[key] = value
    _memory_ttls[key] = time.time() + ttl
    _memory_cache.move_to_end(key)
    # Evict oldest if over size
    while len(_memory_cache) > _MAX_CACHE_SIZE:
        old_key, _ = _memory_cache.popitem(last=False)
        _memory_ttls.pop(old_key, None)
    # Periodic expired eviction (every 50 sets)
    if len(_memory_cache) % 50 == 0:
        _evict_expired()
    # Redis
    r = current_app.redis
    if r:
        try:
            r.setex(key, ttl, serialized)
        except Exception as e:
            logger.warning(f'Redis SET failed for {key}: {e}')

def cache_get_or_compute(key, compute_fn, ttl=300, lock_timeout=30):
    """Get from cache; on miss, acquire distributed lock and compute once.

    Other callers that arrive while the lock is held will wait up to
    *lock_timeout* seconds for the winner to populate the cache.  If the
    wait times out, they fall through and compute themselves (safe
    fallback, avoids indefinite blocking).

    Returns the cached or freshly computed value, or None if compute_fn
    returns None.
    """
    # Fast path — cache hit
    cached_val = cache_get(key)
    if cached_val is not None:
        return cached_val

    r = get_redis()
    lock_key = f'{key}:lock'

    if r:
        try:
            acquired = r.set(lock_key, '1', ex=lock_timeout, nx=True)
        except Exception:
            acquired = True  # Redis down → just compute
        if acquired:
            try:
                result = compute_fn()
                if result is not None:
                    cache_set(key, result, ttl)
                return result
            finally:
                try:
                    r.delete(lock_key)
                except Exception:
                    pass
        else:
            # Another worker is computing — poll for result
            deadline = time.time() + lock_timeout
            while time.time() < deadline:
                time.sleep(0.2)
                cached_val = cache_get(key)
                if cached_val is not None:
                    return cached_val
            # Timeout — fall through and compute ourselves
            logger.debug(f'Cache stampede lock wait timed out for {key}')

    # No Redis or lock wait timed out — compute directly
    result = compute_fn()
    if result is not None:
        cache_set(key, result, ttl)
    return result


def cached(key_prefix, ttl=300, stampede_lock=False):
    """Decorator for caching function results.

    If *stampede_lock* is True, uses ``cache_get_or_compute`` (Redis
    distributed lock) so only one caller computes at a time.
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            cache_key = f'cn:{key_prefix}'
            if stampede_lock:
                return cache_get_or_compute(
                    cache_key,
                    lambda: fn(*args, **kwargs),
                    ttl=ttl,
                )
            cached_val = cache_get(cache_key)
            if cached_val is not None:
                return cached_val
            result = fn(*args, **kwargs)
            if result is not None:
                cache_set(cache_key, result, ttl)
            return result
        return wrapper
    return decorator
