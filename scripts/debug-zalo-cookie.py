import json
import urllib.request
import urllib.error

with open("/opt/mybot/assets/config.json", "r", encoding="utf-8") as f:
    cfg = json.load(f)

cookies = cfg.get("cookie", {}).get("cookies", [])
cookie_header = "; ".join(f"{c.get('name') or c.get('key')}={c.get('value')}" for c in cookies)

url = "https://wpa.chat.zalo.me/api/login/getLoginInfo?nretry=0"
req = urllib.request.Request(
    url,
    headers={
        "Cookie": cookie_header,
        "User-Agent": cfg.get("userAgent", "Mozilla/5.0")
    }
)
try:
    with urllib.request.urlopen(req) as resp:
        body = resp.read().decode()
        print("HTTP Status:", resp.status)
        print("Response Body:", body)
except urllib.error.HTTPError as e:
    print("HTTP Error:", e.code, e.read().decode())
except Exception as e:
    print("Other Error:", e)
