export function executableBook(book,side,amount,c,now=Date.now()){
  if(!book||!Number.isFinite(book.sourceAt)||!Number.isFinite(book.receivedAt)||now-book.receivedAt>c.bookMaxAgeMs||now-book.sourceAt>c.bookMaxAgeMs||book.sourceAt>now+5000)return null;
  const units=book.units;if(!Array.isArray(units)||!units.length)return null;
  if(units.some(u=>![u.ask_price,u.bid_price,u.ask_size,u.bid_size].every(Number.isFinite)||u.ask_price<=0||u.bid_price<=0||u.ask_price<u.bid_price||u.ask_size<0||u.bid_size<0))return null;
  if(units.some((u,i)=>i&&(u.ask_price<units[i-1].ask_price||u.bid_price>units[i-1].bid_price)))return null;
  const ask=units[0].ask_price,bid=units[0].bid_price,mid=(ask+bid)/2;
  const tick=book.key?.startsWith('upbit:KRW-')?krwTick(bid):0;
  const spreadLimit=tick?Math.max(c.maxSpread,Math.min(c.maxTickSpread,tick/mid*1.001)):c.maxSpread;
  if(side==='BUY'&&(ask-bid)/mid>spreadLimit)return null;
  let remaining=side==='BUY'?amount/(1+c.fee):amount,qty=0,gross=0;
  for(const u of units){
    const price=side==='BUY'?u.ask_price:u.bid_price,size=side==='BUY'?u.ask_size:u.bid_size;
    const take=Math.min(size,side==='BUY'?remaining/price:remaining);
    qty+=take;gross+=take*price;remaining-=side==='BUY'?take*price:take;
    if(remaining<1e-8)break;
  }
  if(remaining>1e-6||qty<=0)return null;
  const price=gross/qty;
  if(side==='BUY'&&price/ask-1>c.maxImpact)return null;
  return {price,qty,gross,fee:gross*c.fee};
}
export function normalizeWatchlist(input){
  if(!Array.isArray(input)||input.length>5)throw Error('관심코인은 최대 5개입니다.');
  const symbols=input.map(v=>{if(typeof v!=='string')throw Error('영문 티커를 입력하세요.');return v.trim().toUpperCase().replace(/^KRW-/,'');}).filter(Boolean);
  if(symbols.some(s=>!/^([A-Z0-9]{1,20})$/.test(s)))throw Error('BTC, ETH처럼 영문 티커를 입력하세요.');
  return [...new Set(symbols)];
}
export function krwTick(price){return [[1e6,1000],[5e5,500],[1e5,100],[5e4,50],[1e4,10],[5000,5],[100,1],[10,.1],[1,.01],[.1,.001],[.01,.0001],[.001,.00001],[.0001,.000001],[.00001,.0000001],[0,.00000001]].find(([min])=>price>=min)?.[1]||0;}
