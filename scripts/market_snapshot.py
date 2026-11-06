"""Collect public exchange quotes without any trading credentials."""
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
HEADERS = {"User-Agent": "CoinPaperSnapshot/1.0", "Accept": "application/json"}

def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=16) as response:
        return json.load(response)

def main():
    markets = get("https://api.upbit.com/v1/market/all?isDetails=false")
    krw = [x["market"] for x in markets if x["market"].startswith("KRW-")]
    upbit = []
    for i in range(0, len(krw), 60):
        params = urllib.parse.urlencode({"markets": ",".join(krw[i:i+60])})
        upbit.extend(get("https://api.upbit.com/v1/ticker?" + params))
        time.sleep(0.2)
    data = {"updated_at": datetime.now(timezone.utc).isoformat(), "markets": krw, "upbit": upbit, "bithumb": [], "binance": []}
    try:
        rows = get("https://api.bithumb.com/v1/ticker?markets=" + urllib.parse.quote(",".join("KRW-" + x.split("-")[1] for x in krw[:60]), safe=",-"))
        if isinstance(rows, list): data["bithumb"] = rows
    except Exception as exc:
        print("Bithumb snapshot unavailable:", exc)
    try:
        rows = get("https://api.binance.com/api/v3/ticker/24hr")
        if isinstance(rows, list):
            data["binance"] = [{"symbol": x["symbol"], "lastPrice": x["lastPrice"], "priceChangePercent": x["priceChangePercent"], "quoteVolume": x["quoteVolume"]} for x in rows if x.get("symbol", "").endswith("USDT")]
    except Exception as exc:
        print("Binance snapshot unavailable:", exc)
    (BASE / "market-snapshot.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("Snapshot:", len(upbit), "Upbit tickers", len(data["bithumb"]), "Bithumb tickers")

if __name__ == "__main__":
    main()
