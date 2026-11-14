const BASES = {upbit:'https://api.upbit.com', bithumb:'https://api.bithumb.com'};
export function normalizeQuote(name,t,now=Date.now(),stream=false){
  const market=t.market||t.code,price=Number(t.trade_price),turnover=Number(t.acc_trade_price_24h);
  let stamp=Number(t.timestamp);
  let tradeAt=Number(t.trade_timestamp),offset=0;
  // Observed Bithumb REST responses encode epoch fields with a +09:00 shift.
  // Correct only when independent documented UTC text fields prove that exact shift.
  if(name==='bithumb'&&!stream&&/^\d{8}$/.test(t.trade_date)&&/^\d{6}$/.test(t.trade_time)){
    const d=t.trade_date,s=t.trade_time,utc=Date.parse(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${s.slice(0,2)}:${s.slice(2,4)}:${s.slice(4,6)}Z`);
    const delta=Number(t.trade_timestamp)-utc;
    if(delta>=32400000&&delta<32401000 && stamp>=Number(t.trade_timestamp)){offset=32400000;stamp-=offset;}
  }
  if(!/^KRW-[A-Z0-9]+$/.test(market)||!Number.isFinite(price)||price<=0||!Number.isFinite(turnover)||turnover<0||!Number.isFinite(stamp)||stamp>now+5000)return null;
  tradeAt-=offset;
  return {key:`${name}:${market}`,exchange:name,market,price,turnover,change:Number(t.signed_change_rate)||0,sourceAt:stamp,tradeAt:Number.isFinite(tradeAt)&&tradeAt<=now+5000?tradeAt:null,receivedAt:now,sourceKind:stream?'ticker-stream':'REST'};
}
export class PublicExchange {
  constructor(name, request=fetch) {
    if (!BASES[name]) throw Error('Unsupported exchange');
    this.name=name; this.request=request; this.retryAt=0; this.failures=0; this.lastRequest=0;
  }
  async get(route) {
    if (Date.now()<this.retryAt) throw Error(`${this.name}: retry cooldown`);
    const delay = 250-(Date.now()-this.lastRequest);
    if(delay>0) await new Promise(r=>setTimeout(r,delay));
    this.lastRequest=Date.now();
    try {
      const res=await this.request(BASES[this.name]+route,{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
      if(!res.ok) {
        const seconds=Number(res.headers.get('retry-after'));
        if(res.status===429 || res.status===418) this.retryAt=Date.now()+Math.max(60000,Number.isFinite(seconds)?seconds*1000:0);
        throw Error(`${this.name}: HTTP ${res.status}`);
      }
      const body=await res.json();
      if(!Array.isArray(body)) throw Error(`${this.name}: invalid response`);
      this.failures=0; this.retryAt=0; return body;
    } catch(e) {
      this.failures++;
      this.retryAt=Math.max(this.retryAt,Date.now()+Math.min(300000,2000*2**Math.min(this.failures,7)));
      throw e;
    }
  }
  async markets(includeWarnings=false) {
    return (await this.get('/v1/market/all?isDetails=true')).filter(m=>/^KRW-[A-Z0-9]+$/.test(m.market) && (includeWarnings||((!m.market_warning || m.market_warning==='NONE') && !m.market_event?.warning)));
  }
  async daily(market){
    const rows=await this.get('/v1/candles/days?market='+encodeURIComponent(market)+'&count=100');
    return rows.map(t=>({closedAt:Date.parse(t.candle_date_time_utc+'Z')+86400000,close:Number(t.trade_price),high:Number(t.high_price),low:Number(t.low_price)})).filter(b=>b.closedAt<=Date.now());
  }
  async hourly(market){
    const rows=await this.get('/v1/candles/minutes/60?market='+encodeURIComponent(market)+'&count=200');
    return rows.map(t=>({closedAt:Date.parse(t.candle_date_time_utc+'Z')+3600000,open:Number(t.opening_price),high:Number(t.high_price),low:Number(t.low_price),close:Number(t.trade_price),notional:Number(t.candle_acc_trade_price)})).filter(b=>b.closedAt<=Date.now());
  }
  async books(markets){
    const rows=await this.get('/v1/orderbook?markets='+encodeURIComponent(markets.join(',')));
    return rows.map(t=>({key:this.name+':'+t.market,sourceAt:Number(t.timestamp),receivedAt:Date.now(),units:(t.orderbook_units||[]).map(u=>Object.fromEntries(['ask_price','bid_price','ask_size','bid_size'].map(k=>[k,Number(u[k])])))}));
  }
  async tickers(markets) {
    const result=[];
    for(let i=0;i<markets.length;i+=75) {
      const rows=await this.get('/v1/ticker?markets='+encodeURIComponent(markets.slice(i,i+75).join(',')));
      for(const t of rows) {
        if(!markets.includes(t.market))continue;
        const q=normalizeQuote(this.name,t);if(q)result.push(q);
      }
    }
    return result;
  }
}
