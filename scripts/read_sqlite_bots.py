#!/usr/bin/env python3
"""
Helper script to extract bots table from SQLite database as JSON.
Used by reconcile-node-rust-state.js and migration tools.
"""

import argparse
import json
import os
import sqlite3
import sys

def main():
    parser = argparse.ArgumentParser(description="Read bots from SQLite database as JSON")
    parser.add_argument("--db", default=os.environ.get("MYBOT_DB_PATH", "data/mybot.db"), help="Path to SQLite DB")
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    if not os.path.exists(db_path):
        # Database does not exist yet
        print(json.dumps({"exists": False, "bots": []}))
        sys.exit(0)

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Check if `bots` table exists
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='bots'")
        if not cur.fetchone():
            print(json.dumps({"exists": True, "tableExists": False, "bots": []}))
            sys.exit(0)

        cur.execute("SELECT * FROM bots")
        rows = [dict(r) for r in cur.fetchall()]
        print(json.dumps({"exists": True, "tableExists": True, "bots": rows}))
    except Exception as e:
        print(json.dumps({"exists": True, "error": str(e), "bots": []}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
