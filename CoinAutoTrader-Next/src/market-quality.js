export class MarketQuality {
  constructor(){this.books=new Map();this.trades=new Map();this.ids=new Map();}
  trade(key,t,now=Date.now()){
    const stamp=Number(t.trade_timestamp??t.timestamp),price=Number(t.trade_price),qty=Number(t.trade_volume),side=t.ask_bid;
    if(!Number.isFinite(stamp)||stamp>now+2000||now-stamp>5000||!Number.isFinite(price)||price<=0||!Number.isFinite(qty)||qty<=0||!['ASK','BID'].includes(side))return;
    const id=String(t.sequential_id??'');if(!id)return;
    const ids=this.ids.get(key)||new Set();if(ids.has(id))return;ids.add(id);if(ids.size>5000)ids.delete(ids.values().next().value);this.ids.set(key,ids);
    const h=this.trades.get(key)||[];h.push({at:now,stamp,notional:price*qty,side});while(h.length&&h[0].at<now-120000)h.shift();this.trades.set(key,h);return true;
  }
  book(key,book,now=Date.now()){
    if(!book.units?.length||!Number.isFinite(book.sourceAt)||book.sourceAt>now+2000||now-book.sourceAt>5000)return;
    const units=book.units.slice(0,5);
    if(units.some(u=>![u.ask_price,u.ask_size,u.bid_price,u.bid_size].every(Number.isFinite)||u.ask_price<=0||u.bid_price<=0||u.ask_price<u.bid_price||u.ask_size<0||u.bid_size<0))return;
    const h=this.books.get(key)||[];
    if(h.length&&book.sourceAt<=h.at(-1).sourceAt)return;
    if(h.length&&now-h.at(-1).at<200)return;
    h.push({at:now,sourceAt:book.sourceAt,bid:units.reduce((a,u)=>a+u.bid_price*u.bid_size,0),ask:units.reduce((a,u)=>a+u.ask_price*u.ask_size,0)});
    while(h.length&&h[0].at<now-60000)h.shift();this.books.set(key,h);
  }
  status(key,now=Date.now()){
    const books=(this.books.get(key)||[]).filter(b=>b.at>=now-15000),trades=(this.trades.get(key)||[]).filter(t=>t.at>=now-30000);
    const last=books.at(-1),lastTrade=trades.at(-1);
    const buy=trades.filter(t=>t.side==='BID').reduce((a,t)=>a+t.notional,0),sell=trades.filter(t=>t.side==='ASK').reduce((a,t)=>a+t.notional,0),total=buy+sell;
    const prior=(this.trades.get(key)||[]).filter(t=>t.at>=now-120000&&t.at<now-30000),priorNotional=prior.reduce((a,t)=>a+t.notional,0);
    const baselineReady=prior.length>=10&&prior[0].at<=now-90000&&priorNotional>0;
    const baselinePeriods=prior.length?(now-30000-Math.max(now-120000,prior[0].at))/30000:0;
    const base={ready:false,suspicious:false,reason:'체결·호가 관찰 중',buyRatio:total?buy/total:0,notional:total,trades:trades.length,baselineReady,relativeFlow:baselineReady?total/(priorNotional/baselinePeriods):null,bookSourceAgeMs:last?now-last.sourceAt:null,bookReceiptAgeMs:last?now-last.at:null,lastTradeAgeMs:lastTrade?now-lastTrade.stamp:null};
    if(!last)return {...base,code:'book-pending',reason:'호가 수신 대기'};
    if(now-last.sourceAt>1500||now-last.at>1500)return {...base,code:'book-update-pending',reason:'호가 갱신 대기 · 신규 매수 보류'};
    if(!lastTrade)return {...base,code:'no-recent-trades',reason:'최근 30초 체결 없음 · 신규 매수 대기'};
    if(now-lastTrade.stamp>10000)return {...base,code:'inactive-trading',reason:'최근 체결 뜸함 · 새 체결 대기'};
    if(books.length<4||last.at-books[0].at<10000||books.some((b,i)=>i&&b.at-books[i-1].at>5000))return now-lastTrade.stamp>3000?{...base,code:'inactive-trading',reason:'최근 체결 뜸함 · 새 체결 대기'}:{...base,code:'book-observation',reason:'호가 지속성 관찰 중 (최소 10초)'};
    // Large displayed depth that disappears with little matching execution is a warning, not proof of spoofing.
    let tradeIndex=0;
    for(let i=1;i<books.length;i++){
      const prev=books[i-1],b=books[i],elapsed=b.at-prev.at;if(elapsed>3000)continue;
      while(tradeIndex<trades.length&&trades[tradeIndex].at<prev.at)tradeIndex++;
      const matched={ASK:0,BID:0};
      while(tradeIndex<trades.length&&trades[tradeIndex].at<=b.at){const t=trades[tradeIndex++];matched[t.side]+=t.notional;}
      for(const side of ['bid','ask']){
        const consumed=matched[side==='bid'?'ASK':'BID'];
        if(prev[side]>50000000&&b[side]<prev[side]*.25&&consumed<prev[side]*.10)return {...base,code:'depth-warning',suspicious:true,reason:side==='bid'?'매수 잔량 급감·체결 부족':'매도 잔량 급감·체결 부족'};
      }
    }
    const probeReady=trades.length>=3&&total>=300000;
    if(now-lastTrade.stamp>3000)return {...base,probeReady,code:'inactive-trading',reason:'최근 체결 뜸함 · 새 체결 대기'};
    if(trades.length<10||total<10000000)return {...base,probeReady,code:'insufficient-execution',reason:'체결 건수·금액 확인 중'};
    return {...base,probeReady,code:'ready',ready:true,reason:'체결·호가 확인'};
  }
}
export function kstSession(now=Date.now()){const d=new Date(now+9*3600000),m=d.getUTCHours()*60+d.getUTCMinutes();return m>=180&&m<540?'preopen':m>=540&&m<570?'open':'normal';}
