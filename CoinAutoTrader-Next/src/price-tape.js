// Only accepted, executed trades build price history. Quiet intervals remain gaps.
export class PriceTape {
  constructor(){this.markets=new Map();}
  trade(key,t,now){
    const at=Number(t.trade_timestamp??t.timestamp),price=Number(t.trade_price),qty=Number(t.trade_volume);
    if(!Number.isFinite(at)||at>now+2000||now-at>5000||!Number.isFinite(price)||!Number.isFinite(qty)||!(price>0&&qty>0)||!['BID','ASK'].includes(t.ask_bid))return;
    const h=this.markets.get(key)||[],slot=Math.floor(at/1000)*1000;
    let b=h.findLast(v=>v.at===slot);
    if(!b){b={at:slot,firstAt:at,lastAt:at,open:price,high:price,low:price,close:price,buy:0,sell:0,qty:0,notional:0,count:0};h.push(b);h.sort((a,b)=>a.at-b.at);}
    if(at<b.firstAt){b.firstAt=at;b.open=price;}if(at>=b.lastAt){b.lastAt=at;b.close=price;}
    b.high=Math.max(b.high,price);b.low=Math.min(b.low,price);b[t.ask_bid==='BID'?'buy':'sell']+=price*qty;b.notional+=price*qty;b.qty+=qty;b.count++;
    while(h.length&&h[0].at<now-1800000)h.shift();this.markets.set(key,h);
  }
  rows(key,now){return (this.markets.get(key)||[]).filter(v=>v.at<=now&&v.lastAt<=now&&v.at>=now-1800000);}
}
export function flow(rows,from,to){
  const h=rows.filter(v=>v.at>=from&&v.at<to),sum=k=>h.reduce((s,b)=>s+b[k],0),notional=sum('notional'),qty=sum('qty');
  return {notional,count:sum('count'),buyRatio:notional?sum('buy')/notional:0,vwap:qty?notional/qty:null};
}
const median=a=>{const v=a.map(b=>b.close).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:NaN;};
export function liveShape(rows,q,now){
  const h=rows.filter(v=>v.at>=now-300000&&v.at<=now),first=h.filter(v=>v.at<=now-240000),last=h.filter(v=>v.at>=now-60000),prior=h.filter(v=>v.at>=now-180000&&v.at<now-60000);
  const ready=h.length>=30&&h[0].at<=now-240000&&last.length>=5&&prior.length>=5&&now-h.at(-1).lastAt<=1500&&!h.some((b,i)=>i&&b.at-h[i-1].at>45000);
  const low=a=>a.length?Math.min(...a.map(v=>v.low)):NaN,high=a=>a.length?Math.max(...a.map(v=>v.high)):NaN;
  const bottom=low(h),top=high(h),f30=flow(rows,now-30000,now+1),f5=flow(rows,now-5000,now+1),baseline=flow(rows,now-120000,now-30000);
  const relative=baseline.notional>0?f30.notional/(baseline.notional/3):null;
  const change=median(last)/median(first)-1,risingLow=low(last)>=low(prior),falling=change<-.003||q.price<median(prior)*.997;
  return {ready,bottom,top,width:top/bottom-1,location:top>bottom?(q.price-bottom)/(top-bottom):0,change,risingLow,falling,lastLow:low(last),priorLow:low(prior),f30,f5,relative,aboveVwap:f30.vwap>0&&q.price>=f30.vwap,lastAt:h.at(-1)?.lastAt};
}
