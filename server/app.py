# 24시간 모의매매 서버 (실거래 API 키 사용 안 함)
# pip install fastapi uvicorn httpx
import os, sqlite3, asyncio, time, json
from datetime import datetime, timezone
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI

DB=os.getenv("PAPER_DB","paper_trades.sqlite3")
SYMBOLS=["BTC","ETH","XRP","ADA","DOGE","SOL","IOST","QKC","SAND","RSR"]
def connect():
 c=sqlite3.connect(DB)
 c.execute("create table if not exists events(id integer primary key, ts text, coin text, side text, price real, qty real, reason text)")
 c.execute("create table if not exists positions(coin text primary key, qty real, avg real, peak real)")
 c.execute("create table if not exists kv(k text primary key, v text)")
 c.execute("insert or ignore into kv values('cash','1000000')")
 c.commit()
 return c
def portfolio():
 with connect() as c:
  cash=float(c.execute("select v from kv where k='cash'").fetchone()[0])
  pos=[dict(zip(["coin","qty","avg","peak"],r)) for r in c.execute("select coin,qty,avg,peak from positions")]
  events=[dict(zip(["id","ts","coin","side","price","qty","reason"],r)) for r in c.execute("select * from events order by id desc limit 500")]
 return {"cash":cash,"positions":pos,"events":events,"paper":True}
prices={}; history={}; status={"last_scan":None,"error":None,"running":False}
async def scan():
 async with httpx.AsyncClient(timeout=15) as client:
  markets=(await client.get("https://api.upbit.com/v1/market/all",params={"isDetails":"false"})).json()
  krw=[m["market"] for m in markets if m["market"].startswith("KRW-")]
  rows=[]
  for i in range(0,len(krw),60):
   try:
    r=await client.get("https://api.upbit.com/v1/ticker",params={"markets":",".join(krw[i:i+60])})
    r.raise_for_status(); rows.extend(r.json())
   except Exception: continue
 if not rows: raise RuntimeError("시세 API 조회 실패")
 now=time.time()
 for r in rows:
  if not isinstance(r,dict) or not r.get("trade_price"): continue
  coin=r["market"].removeprefix("KRW-");prices[coin]=r
  h=history.setdefault(coin,[]);h.append((now,float(r["trade_price"])))
  history[coin]=[(t,p) for t,p in h if now-t<1800][-60:]
 candidates=sorted((r for r in rows if isinstance(r,dict) and r.get("signed_change_rate",0)>0.015 and r.get("acc_trade_price_24h",0)>1e9),key=lambda r:r.get("acc_trade_price_24h",0),reverse=True)[:12]
 with connect() as c:
  cash=float(c.execute("select v from kv where k='cash'").fetchone()[0])
  positions={r[0]:list(r[1:]) for r in c.execute("select coin,qty,avg,peak from positions")}
  equity=cash+sum(qty*float(prices.get(coin,{}).get("trade_price",avg)) for coin,(qty,avg,peak) in positions.items())
  for coin,(qty,avg,peak) in list(positions.items()):
   price=float(prices.get(coin,{}).get("trade_price",0))
   if not price:continue
   peak=max(peak,price);rate=price/avg-1;drawdown=price/peak-1
   if rate<=-0.015 or (rate>=0.02 and drawdown<=-0.008) or (rate>=0.06 and drawdown<=-0.015):
    cash+=qty*price;c.execute("delete from positions where coin=?",(coin,))
    c.execute("insert into events(ts,coin,side,price,qty,reason) values(?,?,?,?,?,?)",(datetime.now(timezone.utc).isoformat(),coin,"SELL",price,qty,"stop/trailing"))
    del positions[coin]
   else:c.execute("update positions set peak=? where coin=?",(peak,coin))
  for r in candidates:
   if len(positions)>=20:break
   coin=r["market"].removeprefix("KRW-")
   if coin in positions:continue
   h=history.get(coin,[])
   if len(h)<4 or now-h[0][0]<90:continue
   price=float(r["trade_price"]);high=max(p for _,p in h)
   if not (high*0.98<price<high*0.995 and price>h[-2][1]):continue
   change=r.get("signed_change_rate",0)*100;volume=r.get("acc_trade_price_24h",0)
   score=(2 if change>=5 else 1 if change>=3 else 0)+(2 if volume>=1e10 else 1 if volume>=3e9 else 0)
   units={0:1,1:2,2:4,3:7,4:10}[score]
   amount=int(min(units*100000,1000000,equity*0.1,cash-max(100000,equity*0.1))//100000)*100000
   if amount<100000:continue
   qty=round(amount/price,8);cash-=qty*price
   c.execute("insert into positions values(?,?,?,?)",(coin,qty,price,price))
   c.execute("insert into events(ts,coin,side,price,qty,reason) values(?,?,?,?,?,?)",(datetime.now(timezone.utc).isoformat(),coin,"BUY",price,qty,"trend pullback score "+str(score)))
   positions[coin]=[qty,price,price]
  c.execute("update kv set v=? where k='cash'",(str(cash),));c.commit()
 status["last_scan"]=datetime.now(timezone.utc).isoformat();status["error"]=None
async def loop():
 while True:
  try:await scan()
  except Exception as e:status["error"]=str(e)
  await asyncio.sleep(60)
@asynccontextmanager
async def lifespan(app):
 connect().close();task=asyncio.create_task(loop());status["running"]=True
 try:yield
 finally:task.cancel();status["running"]=False
app=FastAPI(title="Paper Trading Server",lifespan=lifespan)
@app.get("/health")
def health():return status
@app.get("/portfolio")
def get_portfolio():return portfolio()
@app.get("/metrics")
def metrics():
 p=portfolio();trades=p["events"];sells=[e for e in trades if e["side"]=="SELL"]
 # 체결별 매수원가를 정확히 추적하기 전에는 승률 산출을 유보한다.
 return {"closed_trades":len(sells),"win_rate":None,"note":"실현손익 및 승률 계산은 수수료와 포지션 원가 기록을 추가한 후 활성화"}
