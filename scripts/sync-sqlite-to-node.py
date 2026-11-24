#!/usr/bin/env python3
import sqlite3
import json
import os
import sys

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "/opt/mybot"
    db_path = sys.argv[2] if len(sys.argv) > 2 else "/var/lib/mybot/mybot.db"

    if not os.path.exists(db_path):
        print(f"Error: Database {db_path} not found")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute("SELECT bot_key, uid, display_name, is_main, status, cookie_json, imei, user_agent FROM bots")
    rows = c.fetchall()

    state_dir = os.path.join(root, "mybot", "state")
    os.makedirs(state_dir, exist_ok=True)
    os.makedirs(os.path.join(root, "mybot"), exist_ok=True)

    mybots_inventory = {}

    for row in rows:
        bot_key, uid, display_name, is_main, status, cookie_json_str, imei, user_agent = row
        print(f"Processing bot: {bot_key} (UID: {uid}, main: {is_main})")

        try:
            cookie_data = json.loads(cookie_json_str) if isinstance(cookie_json_str, str) else cookie_json_str
        except Exception:
            cookie_data = {}

        bot_state = {
            "id": bot_key,
            "uid": uid,
            "name": display_name or bot_key,
            "isMain": bool(is_main),
            "status": "running" if status in ("running", "online") else "stopped",
            "cookie": cookie_data,
            "imei": imei,
            "userAgent": user_agent,
            "cookieDead": False,
            "connected": True
        }

        state_file = os.path.join(state_dir, f"{bot_key}.json")
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(bot_state, f, indent=2, ensure_ascii=False)
        print(f"  -> Written {state_file}")

        # If main bot, also update assets/config.json
        if is_main or bot_key == "admin":
            config_file = os.path.join(root, "assets", "config.json")
            if os.path.exists(config_file):
                try:
                    with open(config_file, "r", encoding="utf-8") as f:
                        cfg = json.load(f)
                    cfg["uid"] = uid
                    cfg["imei"] = imei
                    cfg["cookie"] = cookie_data
                    cfg["userAgent"] = user_agent
                    with open(config_file, "w", encoding="utf-8") as f:
                        json.dump(cfg, f, indent=2, ensure_ascii=False)
                    print(f"  -> Updated {config_file} with live session UID: {uid}")
                except Exception as e:
                    print(f"  -> Warning updating config.json: {e}")

        mybots_inventory[bot_key] = {
            "id": bot_key,
            "name": display_name or bot_key,
            "isMain": bool(is_main),
            "status": "running" if status in ("running", "online") else "stopped",
            "uid": uid
        }

    mybots_file = os.path.join(root, "mybot", "mybots.json")
    with open(mybots_file, "w", encoding="utf-8") as f:
        json.dump(mybots_inventory, f, indent=2, ensure_ascii=False)
    print(f"  -> Written {mybots_file}")
    print("Sync complete!")

if __name__ == "__main__":
    main()
