#!/usr/bin/env python3
"""
Auto-register Telegram account via hero-sms + telethon.
Then fetch API ID / API Hash from my.telegram.org.
"""

import asyncio
import time
import sys
import os
import requests
import json
import re

from telethon import TelegramClient
from telethon.errors import (
    PhoneNumberBannedError, PhoneNumberFloodError, FloodWaitError,
    SessionPasswordNeededError, PhoneNumberInvalidError
)

# ─── Config ───────────────────────────────────────────────────────
HERO_API_KEY = "df87ce56e3c53e366815e43A07db8ce8"
HERO_BASE = "https://hero-sms.com/stubs/handler_api.php"

# Public api_id/hash for bootstrap (Telegram Desktop open-source)
BOOTSTRAP_API_ID = 611335
BOOTSTRAP_API_HASH = "d524b414d21f4d37f08684c1df41ac9c"

SERVICE = "tg"
PROXY = ('http', '127.0.0.1', 17890)  # HTTP CONNECT proxy for Telegram
SESSION_DIR = os.path.dirname(os.path.abspath(__file__))
SESSION_FILE = os.path.join(SESSION_DIR, "tg_session")

# Countries to try — must match proxy IP country!
COUNTRIES_TO_TRY = [
    (62,  "Turkey"),      # $1.00 — proxy is set to Turkey
]

# ─── Hero-SMS API ─────────────────────────────────────────────────

NO_PROXY = {"http": None, "https": None}  # Bypass proxy for hero-sms

def hero_api(action, **params):
    params["api_key"] = HERO_API_KEY
    params["action"] = action
    r = requests.get(HERO_BASE, params=params, timeout=30, proxies=NO_PROXY)
    return r.text.strip()

def hero_api_raw(action, **params):
    params["api_key"] = HERO_API_KEY
    params["action"] = action
    r = requests.get(HERO_BASE, params=params, timeout=30, proxies=NO_PROXY)
    return r

def get_balance():
    resp = hero_api("getBalance")
    if resp.startswith("ACCESS_BALANCE:"):
        return float(resp.split(":")[1])
    return 0.0

def buy_number(country):
    """Buy a number. Returns (activation_id, phone_number) or raises."""
    resp = hero_api_raw("getNumberV2", service=SERVICE, country=country)
    text = resp.text.strip()

    # V2 returns JSON
    try:
        data = json.loads(text)
        if "activationId" in data:
            return str(data["activationId"]), str(data["phoneNumber"])
        else:
            return None, text
    except json.JSONDecodeError:
        # V1 format: ACCESS_NUMBER:id:phone
        if text.startswith("ACCESS_NUMBER:"):
            parts = text.split(":")
            return parts[1], parts[2]
        return None, text

def get_sms_code(activation_id, timeout=150, poll_interval=5):
    """Poll for SMS code. Returns code string or None."""
    start = time.time()
    while time.time() - start < timeout:
        resp = hero_api("getStatus", id=activation_id)
        if resp.startswith("STATUS_OK:"):
            code = resp.split(":")[1]
            return code
        elif resp == "STATUS_WAIT_CODE" or resp == "STATUS_WAIT_RETRY":
            elapsed = int(time.time() - start)
            print(f"    ... waiting for SMS ({elapsed}s)", flush=True)
            time.sleep(poll_interval)
        elif resp == "STATUS_CANCEL":
            return None
        else:
            print(f"    ? Status: {resp}", flush=True)
            time.sleep(poll_interval)
    return None

def cancel_number(activation_id):
    return hero_api("setStatus", id=activation_id, status=8)

def confirm_sms(activation_id):
    return hero_api("setStatus", id=activation_id, status=6)

def mark_ready(activation_id):
    """Mark as ready to receive SMS (status 1)."""
    return hero_api("setStatus", id=activation_id, status=1)

# ─── Telegram Registration ────────────────────────────────────────

async def try_register(phone, activation_id):
    """Try to register/sign-in on Telegram with the given phone."""

    # Clean up old session
    for ext in ("", ".session"):
        p = SESSION_FILE + ext
        if os.path.exists(p):
            os.remove(p)

    client = TelegramClient(SESSION_FILE, BOOTSTRAP_API_ID, BOOTSTRAP_API_HASH, proxy=PROXY)
    await client.connect()

    try:
        print(f"    → Sending code request to +{phone}...", flush=True)
        result = await client.send_code_request(f"+{phone}")
        phone_code_hash = result.phone_code_hash
        print(f"    → Code request sent. Polling hero-sms...", flush=True)

        # Mark ready to receive
        mark_ready(activation_id)

        # Poll for code
        code = get_sms_code(activation_id, timeout=150)
        if not code:
            print(f"    ✗ No SMS code received", flush=True)
            await client.disconnect()
            return False

        # Extract just digits from code
        code = re.sub(r'[^\d]', '', code)
        print(f"    → Got code: {code}", flush=True)

        # Try sign in
        try:
            await client.sign_in(f"+{phone}", code, phone_code_hash=phone_code_hash)
            print(f"    ✓ Signed in!", flush=True)
            confirm_sms(activation_id)
            return True
        except SessionPasswordNeededError:
            print(f"    ✗ Account has 2FA password", flush=True)
            await client.disconnect()
            return False
        except Exception as sign_in_err:
            err_str = str(sign_in_err).lower()
            if "not registered" in err_str or "sign_up" in err_str or "firstname" in err_str:
                print(f"    → Not registered, signing up...", flush=True)
                try:
                    await client.sign_up(code, "World", "Monitor",
                                        phone_code_hash=phone_code_hash)
                    print(f"    ✓ Registered!", flush=True)
                    confirm_sms(activation_id)
                    return True
                except Exception as signup_err:
                    print(f"    ✗ Sign up failed: {signup_err}", flush=True)
                    await client.disconnect()
                    return False
            else:
                print(f"    ✗ Sign in error: {sign_in_err}", flush=True)
                await client.disconnect()
                return False

    except PhoneNumberBannedError:
        print(f"    ✗ Number banned by Telegram", flush=True)
    except PhoneNumberInvalidError:
        print(f"    ✗ Invalid phone number format", flush=True)
    except PhoneNumberFloodError:
        print(f"    ✗ Flood (too many attempts)", flush=True)
    except FloodWaitError as e:
        print(f"    ✗ Flood wait: {e.seconds}s", flush=True)
    except Exception as e:
        print(f"    ✗ Error: {e}", flush=True)

    await client.disconnect()
    return False

# ─── my.telegram.org ──────────────────────────────────────────────

async def get_api_credentials(phone):
    """Get API ID / Hash from my.telegram.org."""
    client = TelegramClient(SESSION_FILE, BOOTSTRAP_API_ID, BOOTSTRAP_API_HASH, proxy=PROXY)
    await client.connect()

    if not await client.is_user_authorized():
        print("  ✗ Not logged in to Telegram. Cannot fetch API creds.")
        await client.disconnect()
        return None

    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"
    session.proxies = {"http": "http://127.0.0.1:17890", "https": "http://127.0.0.1:17890"}

    print("\n═══ Fetching API credentials from my.telegram.org ═══")
    print(f"  → Requesting auth for +{phone}...", flush=True)

    resp = session.post("https://my.telegram.org/auth/send_password",
                       data={"phone": f"+{phone}"},
                       timeout=30)

    try:
        data = resp.json()
    except:
        print(f"  ✗ Bad response: {resp.text[:200]}")
        await client.disconnect()
        return None

    if "random_hash" not in data:
        print(f"  ✗ Failed: {data}")
        await client.disconnect()
        return None

    random_hash = data["random_hash"]
    print(f"  → Waiting for Telegram message with login code...", flush=True)

    await asyncio.sleep(5)

    code = None
    for attempt in range(30):
        try:
            messages = await client.get_messages(777000, limit=5)
            for msg in messages:
                if msg.text and msg.date.timestamp() > time.time() - 180:
                    match = re.search(r'(\d{5,6})', msg.text)
                    if match:
                        code = match.group(1)
                        break
        except Exception as e:
            print(f"    ? Message read error: {e}", flush=True)

        if code:
            break
        if attempt % 4 == 0:
            print(f"    ... waiting ({(attempt+1)*2}s)", flush=True)
        await asyncio.sleep(2)

    if not code:
        print(f"  ✗ No auth code received via Telegram message")
        await client.disconnect()
        return None

    print(f"  → Got code: {code}", flush=True)

    resp = session.post("https://my.telegram.org/auth/login",
                       data={"phone": f"+{phone}",
                              "random_hash": random_hash,
                              "password": code},
                       timeout=30)

    # Check cookies for auth
    if not session.cookies:
        print(f"  ✗ Login failed (no cookies)")
        await client.disconnect()
        return None

    print(f"  ✓ Logged into my.telegram.org", flush=True)

    # Get apps page
    resp = session.get("https://my.telegram.org/apps", timeout=30)
    html = resp.text

    # Check if we need to create an app
    if "Create new application" in html or "app_title" in html:
        print(f"  → Creating new app...", flush=True)

        hash_match = re.search(r'name="hash"\s+value="([^"]*)"', html)
        app_hash = hash_match.group(1) if hash_match else ""

        resp = session.post("https://my.telegram.org/apps/create",
                           data={
                               "hash": app_hash,
                               "app_title": "WorldMonitor",
                               "app_shortname": "worldmonitor",
                               "app_url": "",
                               "app_platform": "other",
                               "app_desc": ""
                           },
                           timeout=30)

        # Re-fetch
        resp = session.get("https://my.telegram.org/apps", timeout=30)
        html = resp.text

    # Parse api_id and api_hash
    id_match = re.search(r'<label[^>]*>App api_id.*?<strong>(\d+)</strong>', html, re.DOTALL)
    if not id_match:
        id_match = re.search(r'api_id.*?<strong>(\d+)</strong>', html, re.DOTALL)
    if not id_match:
        id_match = re.search(r'<strong>(\d{5,10})</strong>', html)

    hash_match = re.search(r'api_hash.*?<span[^>]*>([a-f0-9]{32})</span>', html, re.DOTALL)
    if not hash_match:
        hash_match = re.search(r'([a-f0-9]{32})', html)

    if id_match and hash_match:
        api_id = id_match.group(1)
        api_hash = hash_match.group(1)
        await client.disconnect()
        return api_id, api_hash

    print(f"  ✗ Could not parse credentials from page")
    # Save for debugging
    with open(os.path.join(SESSION_DIR, "my_telegram_debug.html"), "w") as f:
        f.write(html)
    print(f"  Saved debug HTML to my_telegram_debug.html")
    await client.disconnect()
    return None

# ─── Main ─────────────────────────────────────────────────────────

async def main():
    balance = get_balance()
    print(f"Hero-SMS balance: ${balance:.2f}\n")

    # Check for existing activations first
    resp = hero_api_raw("getActiveActivations", service=SERVICE)
    existing = []
    try:
        data = json.loads(resp.text)
        if "activeActivations" in data:
            for act_id, info in data["activeActivations"].items():
                phone = info.get("phoneNumber", "")
                print(f"  Found existing activation: {act_id} → +{phone}")
                existing.append((act_id, phone))
    except:
        pass

    registered_phone = None

    # Try existing activations first
    for act_id, phone in existing:
        print(f"\n── Using existing number: +{phone} (act={act_id}) ──")
        success = await try_register(phone, act_id)
        if success:
            registered_phone = phone
            break
        else:
            print(f"    Cancelling...", flush=True)
            cancel_number(act_id)
            await asyncio.sleep(1)

    # If no existing worked, buy new ones
    if not registered_phone:
        balance = get_balance()
        for country_id, country_name in COUNTRIES_TO_TRY:
            if balance < 0.10:
                print(f"\n✗ Balance too low (${balance:.2f})")
                break

            print(f"\n── Buying: {country_name} (country={country_id}) ──")
            act_id, phone = buy_number(country_id)
            if not act_id:
                print(f"    ✗ Buy failed: {phone}")
                continue

            print(f"    ✓ Got: +{phone} (act={act_id})")
            success = await try_register(phone, act_id)

            if success:
                registered_phone = phone
                break
            else:
                cancel_number(act_id)
                balance = get_balance()
                await asyncio.sleep(2)

    if not registered_phone:
        print(f"\n✗ All attempts failed.")
        return

    # Get API credentials
    print(f"\n✓ Telegram registered: +{registered_phone}")
    creds = await get_api_credentials(registered_phone)

    if creds:
        api_id, api_hash = creds
        print(f"\n{'='*50}")
        print(f"  TELEGRAM_API_ID={api_id}")
        print(f"  TELEGRAM_API_HASH={api_hash}")
        print(f"{'='*50}")

        # Save to file
        with open(os.path.join(SESSION_DIR, "telegram_creds.txt"), "w") as f:
            f.write(f"TELEGRAM_API_ID={api_id}\n")
            f.write(f"TELEGRAM_API_HASH={api_hash}\n")
            f.write(f"PHONE=+{registered_phone}\n")
        print(f"\n  Saved to scripts/telegram_creds.txt")
    else:
        print(f"\n⚠ Could not auto-fetch API credentials.")
        print(f"  Try manually: https://my.telegram.org/apps")

if __name__ == "__main__":
    asyncio.run(main())
