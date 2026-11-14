import {executableBook,normalizeWatchlist,krwTick} from './execution.js';
import {MarketQuality,kstSession} from './market-quality.js';
import {PriceTape} from './price-tape.js';
import {baseSetup,morningPlan,manageMorning,entryModes} from './morning-strategy.js';
import {defaultStrategies,validateStrategySettings} from './strategy-settings.js';
function updateLoss(map,t){if(t.side!=='SELL'||t.reason==='partial-profit')return;const key=t.exchange+':'+t.market,old=map.get(key);map.set(key,{at:t.at,pnl:t.pnl,streak:t.pnl<0?(old?.pnl<0&&t.at-old.at<1800000?old.streak+1:1):0});}
export class LiveBroker {execute(){throw Error('실전 주문은 비활성화되어 있습니다.');}}
export class PaperEngine {
  constructor(store,config){
    this.store=store;this.c=config;this.state=config.separateAccounts?store.migrateAccounts(config.initialCash):store.read();
    this.history=new Map();this.slowHistory=new Map();this.quotes=new Map();this.daily=new Map();this.books=new Map();this.quality=new MarketQuality();this.tape=new PriceTape();this.hourly=store.hourly?.()||new Map();this.setups=new Map();this.metrics={};this.startedAt=Date.now();this.decisionTimes=new Map();this.frameTimes=new Map();this.losses=new Map();
    for(const t of store.trades(2000).reverse())updateLoss(this.losses,t);
    if(this.state.strategyRevision!==15){
      const next=structuredClone(this.state),prior=next.settings?.strategies;
      next.settings={...next.settings,strategies:{selected:prior?.selected?.length===0?[]:defaultStrategies,orderCap:prior?.orderCap??config.probeMaxKrw,riskKrw:prior?.riskKrw??config.tradeRiskKrw}};
      next.strategyRevision=15;store.commit(next);this.state=next;store.event('strategy-reset','구 전략 제외 · 새 매수 기반/9시 초기 진입/추세 재지지 적용 · 계좌 기록과 위험 예산 보존');
    }
  }
  commit(state,trade,audit){
    if(!this.accountExchange)return this.store.commit(state,trade,audit);
    const exchange=this.accountExchange,root=structuredClone(this.accountRoot),{positions,cooldowns,paused,...account}=state;
    root.accounts[exchange]=account;
    root.positions={...Object.fromEntries(Object.entries(root.positions).filter(([,p])=>p.exchange!==exchange)),...positions};
    root.cooldowns={...Object.fromEntries(Object.entries(root.cooldowns).filter(([key])=>!key.startsWith(exchange+':'))),...cooldowns};
    root.cash=Object.values(root.accounts).reduce((a,v)=>a+v.cash,0);root.realized=Object.values(root.accounts).reduce((a,v)=>a+v.realized,0);
    root.halted=Object.values(root.accounts).some(a=>a.halted);root.drawdownHalted=Object.values(root.accounts).some(a=>a.drawdownHalted);
    this.store.commit(root,trade,audit);this.accountRoot=root;
  }
  accountSnapshot(exchange){
    const a=this.state.accounts[exchange],positions=Object.values(this.state.positions).filter(p=>p.exchange===exchange);
    const holdingValue=positions.reduce((sum,p)=>sum+p.qty*(this.quotes.get(exchange+':'+p.market)?.price??p.entry),0),cost=positions.reduce((sum,p)=>sum+p.cost,0);
    return {...a,exchange,holdingValue,holdingCost:cost,equity:a.cash+holdingValue,unrealized:holdingValue-cost,positionCount:positions.length,stale:positions.some(p=>!this.fresh(this.quotes.get(exchange+':'+p.market),Date.now()))};
  }
  fresh(t,now){return t && now-t.sourceAt<=this.c.maxAgeMs && now-t.receivedAt<=this.c.maxAgeMs && t.sourceAt<=now+5000;}
  watchlist(){return this.state.settings?.watchlist||this.accountRoot?.settings?.watchlist||['BTC','ETH'];}
  limits(exchange){
    const settings=(this.accountRoot||this.state).settings?.limits?.[exchange];
    return settings||{maxExposure:this.c.maxExposure,maxInvestedKrw:null};
  }
  exposureLimit(equity,exchange=this.accountExchange||this.c.executionExchange){const l=this.limits(exchange);return Math.min(equity*l.maxExposure,l.maxInvestedKrw??Infinity);}
  strategySettings(){return (this.accountRoot||this.state).settings?.strategies||{selected:defaultStrategies,orderCap:this.c.probeMaxKrw,riskKrw:this.c.tradeRiskKrw};}
  setStrategySettings(input){const value=validateStrategySettings(input),next=structuredClone(this.state);next.settings={...next.settings,strategies:value};this.commit(next);this.state=next;this.store.event('strategies','전략 선택·매수 상한·예상 손실 예산 저장');return value;}
  setRetention(value){
    if(!Number.isFinite(value)||value<90||value>95)throw Error('보호 목표는 90~95%로 입력하세요.');
    const next=structuredClone(this.state);next.settings={...next.settings,retention:value/100};this.commit(next);this.state=next;return value;
  }
  manualSell(key,now=Date.now()){
    if(typeof key!=='string'||!this.state.positions[key])throw Error('현재 보유하지 않은 종목입니다.');
    const t=this.quotes.get(key),p=this.state.positions[key];
    const book=this.books.get(key);if(!t||!book||now-book.sourceAt>1500||now-book.receivedAt>1500)throw Error('신선한 매도 호가 수신 후 다시 시도하세요.');
    const fill=executableBook(this.books.get(key),'SELL',p.qty,this.c,now);
    if(!fill)throw Error('신선한 매도 호가 또는 체결 가능한 잔량이 부족합니다.');
    if(!this.c.separateAccounts){this.fillV2(t,'SELL','manual-sell',fill,now);return;}
    this.accountRoot=this.state;this.accountExchange=p.exchange;
    this.state={...structuredClone(this.accountRoot.accounts[p.exchange]),positions:Object.fromEntries(Object.entries(this.accountRoot.positions).filter(([,v])=>v.exchange===p.exchange)),cooldowns:{...this.accountRoot.cooldowns},paused:this.accountRoot.paused};
    try{this.fillV2(t,'SELL','manual-sell',fill,now);}finally{this.state=this.accountRoot;this.accountRoot=null;this.accountExchange=null;}
  }
  setLimits(input){
    if(!input||Object.keys(input).some(k=>!['upbit','bithumb'].includes(k)))throw Error('거래소별 투자 한도를 입력하세요.');
    const limits={...(this.state.settings?.limits||{})};
    for(const [ex,v] of Object.entries(input)){
      if(!v||typeof v.percent!=='number'||!Number.isFinite(v.percent)||v.percent<0||v.percent>100)throw Error('투자 비율은 0~100% 숫자여야 합니다.');
      const cap=v.krw===null||v.krw===undefined?null:v.krw;
      if(cap!==null&&(typeof cap!=='number'||!Number.isSafeInteger(cap)||cap<0||cap>1e12))throw Error('금액 한도는 0 이상의 원 단위 정수여야 합니다.');
      limits[ex]={maxExposure:v.percent/100,maxInvestedKrw:cap};
    }
    const next=structuredClone(this.state);next.settings={...next.settings,limits};this.commit(next);this.state=next;this.store.event('limits','거래소별 투자 한도 변경 (기존 보유분 강제 매도 없음)');return limits;
  }
  setWatchlist(symbols){
    const watchlist=normalizeWatchlist(symbols);
    if(watchlist.some(s=>![...this.quotes.values()].some(q=>q.market==='KRW-'+s)&&![...(this.catalog?.values()||[])].some(markets=>markets.has('KRW-'+s))))throw Error('지원하는 원화 마켓의 영문 티커를 입력하세요.');
    const next=structuredClone(this.state);next.settings={...next.settings,watchlist};this.commit(next);this.state=next;this.store.event('watchlist','관심코인 저장: '+watchlist.join(', '));return watchlist;
  }
  equity(){return this.state.cash+Object.entries(this.state.positions).reduce((a,[key,p])=>a+p.qty*(this.quotes.get(key)?.price??p.entry),0);}
  setHourly(key,bars,now=Date.now()){
    bars=bars.filter(b=>b.closedAt<=now);
    if(!bars.length||bars.some(b=>![b.closedAt,b.open,b.high,b.low,b.close,b.notional].every(Number.isFinite)||b.low<=0||b.high<b.low||b.open<b.low||b.open>b.high||b.close<b.low||b.close>b.high||b.notional<0))throw Error(key+': 유효한 완료 시간봉 없음 ('+bars.length+'개)');
    const merged=new Map((this.hourly.get(key)||[]).map(b=>[b.closedAt,b]));for(const b of bars)merged.set(b.closedAt,b);
    bars=[...merged.values()].sort((a,b)=>a.closedAt-b.closedAt).slice(-200);
    this.store.saveHourly?.(key,bars,now);this.hourly.set(key,bars);this.setups.delete(key);
  }
  control(action){
    const next=structuredClone(this.state);
    if(action==='pause') next.paused=true;
    else if(action==='resume') next.paused=false;
    else throw Error('Unknown action');
    this.commit(next);this.state=next;this.store.event('control',action);
  }
  fillV2(t,side,reason,fill,now,details={}){
    if(this.c.separateAccounts&&!this.accountExchange)throw Error('Exchange account context required');
    const next=structuredClone(this.state);let pnl=0;
    if(side==='BUY'){
      const amount=details.orderAmount??this.c.orderKrw;
      if(next.cash<amount)return;
      next.cash-=amount;
      if(details.add){const p=next.positions[t.key];if(!p)throw Error('Missing probe position');const qty=p.qty+fill.qty;next.positions[t.key]={...p,qty,entry:(p.entry*p.qty+fill.price*fill.qty)/qty,cost:p.cost+amount,additions:1};}
      else next.positions[t.key]={exchange:t.exchange,market:t.market,qty:fill.qty,entry:fill.price,cost:amount,openedAt:now,strategy:this.c.strategy,...details};
    }else{
      const p=next.positions[t.key];if(!p)return;
      const allocatedCost=details.partial?p.cost*fill.qty/p.qty:p.cost;
      pnl=fill.gross-fill.fee-allocatedCost;next.cash+=fill.gross-fill.fee;next.realized+=pnl;
      if(details.partial){
        if(p.partialTaken||!(fill.qty>0&&fill.qty<p.qty))throw Error('Invalid partial exit');
        next.positions[t.key]={...p,qty:p.qty-fill.qty,cost:p.cost-allocatedCost,partialTaken:true};
      }else{
        delete next.positions[t.key];next.cooldowns[t.key]=this.c.freshReentry?0:now+this.c.cooldownMs;
        if(this.c.freshReentry)next.lastExits={...next.lastExits,[t.key]:{at:now,price:fill.price,sourceAt:t.sourceAt}};
      }
    }
    const trade={at:now,exchange:t.exchange,market:t.market,side,price:fill.price,qty:fill.qty,fee:fill.fee,pnl,reason};
    const p=this.state.positions[t.key]||next.positions[t.key];const audit={at:now,key:t.key,side,reason,price:fill.price,fee:fill.fee,pnl,highest:p?.highest,stop:p?.stop,entryContext:p?.entryContext,tradeRole:p?.tradeRole,holdMode:p?.holdMode,protectedPeakPnl:p?.protectedPeakPnl,retentionPending:p?.retentionPending,effectiveRetention:p?.effectiveRetention,managementRevision:p?.managementRevision,sourceAt:t.sourceAt,bookAt:this.books.get(t.key)?.sourceAt};
    this.commit(next,trade,audit);this.state=next;if(side==='SELL'&&!details.partial)updateLoss(this.losses,trade);
  }
  eligibleMarkets(){return [...(this.catalog?.get(this.c.executionExchange)||new Set([...this.quotes.values()].filter(q=>q.exchange===this.c.executionExchange).map(q=>q.market)))];}
  recordTrade(key,t,now){this.tape.trade(key,t,now);}
  ingest(rows,now=Date.now()){
    for(const t of rows){
      const previous=this.quotes.get(t.key);
      if(previous&&t.sourceAt<previous.sourceAt){previous.feedReceivedAt=Math.max(previous.feedReceivedAt||0,t.receivedAt);continue;}
      t.feedReceivedAt=Math.max(t.receivedAt,previous?.feedReceivedAt||0);this.quotes.set(t.key,t);
      if(!this.fresh(t,now))continue;
      const h=this.history.get(t.key)||[];if(!h.length||now-h.at(-1).at>=1000)h.push({at:now,price:t.price});while(h.length&&h[0].at<now-1800000)h.shift();this.history.set(t.key,h);
    }
  }
  setup(key,now){return baseSetup(this.hourly.get(key)||[],now);}
  sessionPlan(t,now){return morningPlan({q:t,rows:this.tape.rows(t.key,now),bars:this.hourly.get(t.key)||[],quality:this.quality.status(t.key,now),book:this.books.get(t.key),c:{...this.c,selectedStrategyModes:this.strategySettings().selected},now});}
  entryBlock(t,now,plan){
    if(t.exchange!==this.c.executionExchange||t.tradeAllowed===false||this.catalog?.has(t.exchange)&&!this.catalog.get(t.exchange).has(t.market))return '신규 매수 대상 제외';
    if(this.state.paused)return '모의매매 일시정지';
    if(!this.strategySettings().selected.some(v=>entryModes.includes(v)))return '선택된 신규 매수 전략 없음';
    if(this.state.halted||this.state.drawdownHalted)return '계좌 손실 한도 도달';
    if(now-this.startedAt<this.c.warmupMs)return '시작 관찰 준비 중';
    if(!this.fresh(t,now)||now-t.sourceAt>1500||now-t.receivedAt>1500)return '새 체결 시세 확인 대기';
    if(this.state.positions[t.key])return '보유 관리';
    if(Object.keys(this.state.positions).some(k=>!this.fresh(this.quotes.get(k),now)))return '보유 종목 시세 확인 대기';
    if(Object.keys(this.state.positions).length>=this.c.maxPositions)return '최대 보유 종목 수 도달';
    if(!plan.ready)return plan.reason;
    const loss=this.losses.get(t.key);if(loss?.streak>=2&&now-loss.at<600000)return '동일 종목 연속 손절 · 10분 재관찰';
    const exit=this.state.lastExits?.[t.key];
    if(exit){const post=this.tape.rows(t.key,now).filter(v=>v.firstAt>exit.at);if(now-exit.at<20000||post.length<6||t.price<post[0].close*1.001)return '매도 후 새 기반·새 상승 확인 대기';}
    return null;
  }
  entryPriceSafe(t,fill){return !!fill&&Math.abs(fill.price/t.price-1)<=Math.min(.0075,Math.max(.002,1.01*krwTick(t.price)/t.price));}
  sessionAmount(plan,cash,room){return Math.min(this.c.minOrderKrw,this.strategySettings().orderCap,cash,room);}
  sessionOrder(t,plan,cash,room,now){
    const cap=Math.floor(this.sessionAmount(plan,cash,room)/10000)*10000;if(cap<this.c.minOrderKrw)return {reason:'모의 현금·투자 한도 부족'};
    const fill=executableBook(this.books.get(t.key),'BUY',cap,this.c,now);
    if(!this.entryPriceSafe(t,fill))return {reason:'실행 호가·체결가 차이 확인 대기'};
    const stop=plan.invalidation,tick=krwTick(fill.price);
    if(!(stop>0&&stop<fill.price)||fill.price-stop<tick*.9||(fill.price-stop)/fill.price>.05)return {reason:'관측 지지선·손절 폭 부적합'};
    const reserve=Math.max(tick,fill.price*.001),risk=cap-fill.qty*(stop-reserve)*(1-this.c.fee);
    if(risk>this.strategySettings().riskKrw)return {reason:'호가 변동 여유 포함 손실 예산 초과'};
    const exit=executableBook(this.books.get(t.key),'SELL',fill.qty,this.c,now);
    if(!exit||(cap-exit.gross+exit.fee)/cap>Math.min(.008,(fill.price-stop)/fill.price*.6))return {reason:'왕복 체결 비용 과다'};
    return {amount:cap,fill,distance:fill.price-stop,reserve,estimatedRisk:risk,reason:null};
  }
  recordFrame(t,now,initial=false,force=false){
    if(!this.store.replay)return;const previous=this.frameTimes.get(t.key)||0;if(!initial&&!force&&now-previous<1000)return;
    this.store.replay({revision:15,at:now,key:t.key,initial,position:structuredClone(this.state.positions[t.key]??null),management:{allowTrend:this.strategySettings().selected.includes('hold-rising'),peakProfitRetention:(this.accountRoot||this.state).settings?.retention??this.c.peakProfitRetention},quote:structuredClone(t),book:structuredClone(this.books.get(t.key)),quality:this.quality.status(t.key,now),tape:this.tape.rows(t.key,now).filter(b=>initial||b.at>=previous-1000).map(b=>({...b})),...(initial?{bars:this.hourly.get(t.key)||[],settings:structuredClone(this.strategySettings())}:{})});this.frameTimes.set(t.key,now);
  }
  recordDecision(t,plan,reason,now){
    const previous=this.decisionTimes.get(t.key);
    if(previous&&now-previous<60000&&reason!=='매수 실행')return;
    this.store.decision?.({revision:15,at:now,key:t.key,mode:plan.mode,ready:plan.ready,reason,price:t.price,change:t.change,sourceAt:t.sourceAt,shape:plan.shape,setup:plan.setup,quality:this.quality.status(t.key,now)});this.decisionTimes.set(t.key,now);
  }
  tick(now=Date.now()){
    if(!this.c.separateAccounts){this.tickAccount(now);return;}
    for(const exchange of ['upbit','bithumb']){
      this.accountRoot=this.state;this.accountExchange=exchange;
      this.state={...structuredClone(this.accountRoot.accounts[exchange]),paused:this.accountRoot.paused,positions:Object.fromEntries(Object.entries(this.accountRoot.positions).filter(([,p])=>p.exchange===exchange)),cooldowns:Object.fromEntries(Object.entries(this.accountRoot.cooldowns).filter(([k])=>k.startsWith(exchange+':')))};
      try{this.tickAccount(now);}finally{this.state=this.accountRoot;this.accountRoot=null;this.accountExchange=null;}
    }
  }
  tickAccount(now){
    const day=new Date(now+9*3600000).toISOString().slice(0,10),fresh=Object.keys(this.state.positions).every(k=>this.fresh(this.quotes.get(k),now));
    if(fresh){const next=structuredClone(this.state),equity=this.equity();if(next.baselinePending){next.dayEquity=equity;next.highWater=equity;next.baselinePending=false;}if(next.day!==day){next.day=day;next.dayEquity=equity;next.halted=false;}next.highWater=Math.max(next.highWater||equity,equity);if(equity<=next.dayEquity*(1-this.c.dailyLossLimit))next.halted=true;if(equity<=next.highWater*(1-this.c.highWaterLossLimit))next.drawdownHalted=true;if(JSON.stringify(next)!==JSON.stringify(this.state)){this.commit(next);this.state=next;}}
    for(const [key,old] of Object.entries(this.state.positions)){
      const t=this.quotes.get(key),book=this.books.get(key);if(!t||!book||now-book.sourceAt>1500||now-book.receivedAt>1500)continue;
      this.recordFrame(t,now);const fill=executableBook(this.books.get(key),'SELL',old.qty,this.c,now);if(!fill)continue;
      const seed={...old,stop:old.stop??old.entry*.985,highest:old.highest??old.entry};
      const r=manageMorning(seed,t,fill,this.tape.rows(key,now),{...this.c,allowTrend:this.strategySettings().selected.includes('hold-rising'),peakProfitRetention:(this.accountRoot||this.state).settings?.retention??this.c.peakProfitRetention},now);
      if(!this.strategySettings().selected.includes('hold-rising')){r.strong=false;r.position.holdMode='base-watch';}
      if(JSON.stringify(r.position)!==JSON.stringify(old)){const next=structuredClone(this.state);next.positions[key]=r.position;this.commit(next);this.state=next;}
      const reason=this.state.halted||this.state.drawdownHalted?'account-risk-exit':r.reason;
      if(reason){this.recordFrame(t,now,false,true);this.fillV2(t,'SELL',reason,fill,now);continue;}
      if(r.partial&&this.strategySettings().selected.includes('scale-out')){const partial=executableBook(this.books.get(key),'SELL',old.qty/2,this.c,now);if(partial)this.fillV2(t,'SELL','partial-profit',partial,now,{partial:true});continue;}
      // Add only to an already profitable, protected holding. No averaging down.
      if(fresh&&r.strong&&this.strategySettings().selected.includes('hold-rising')&&fill.gross-fill.fee>=old.cost*1.01&&r.position.stop>=old.cost/(old.qty*(1-this.c.fee))&&!old.additions&&!old.partialTaken&&!this.state.paused&&!this.state.halted&&!this.state.drawdownHalted&&(this.accountExchange||t.exchange)===this.c.executionExchange){
        const room=this.exposureLimit(this.equity())-(this.equity()-this.state.cash);
        let amount=Math.floor(Math.min(this.strategySettings().orderCap-old.cost,this.c.orderKrw-old.cost,this.state.cash,room)/10000)*10000;
        let extra=amount>=this.c.minOrderKrw?executableBook(this.books.get(key),'BUY',amount,this.c,now):null;
        if(extra){
          const reserve=Math.max(krwTick(extra.price),extra.price*.001),riskOld=old.cost-old.qty*(r.position.stop-reserve)*(1-this.c.fee);
          const fraction=1-(r.position.stop-reserve)*(1-this.c.fee)/(extra.price*(1+this.c.fee));
          if(fraction>0)amount=Math.floor(Math.min(amount,(this.strategySettings().riskKrw-riskOld)/fraction)/10000)*10000;
          extra=amount>=this.c.minOrderKrw?executableBook(this.books.get(key),'BUY',amount,this.c,now):null;
          if(extra&&this.entryPriceSafe(t,extra)&&now-t.sourceAt<=1500&&now-this.books.get(key).sourceAt<=1500){
            const margin=Math.max(krwTick(extra.price),extra.price*.001),risk=old.cost+amount-(old.qty+extra.qty)*(r.position.stop-margin)*(1-this.c.fee),roundtrip=executableBook(this.books.get(key),'SELL',old.qty+extra.qty,this.c,now);
            if(roundtrip&&risk<=this.strategySettings().riskKrw)this.fillV2(t,'BUY','protected-strength-add',extra,now,{orderAmount:amount,add:true});
          }
        }
      }
    }
    if(this.accountExchange&&this.accountExchange!==this.c.executionExchange)return;
    const ranked=this.eligibleMarkets().map(m=>this.quotes.get(this.c.executionExchange+':'+m)).filter(Boolean).map(t=>({t,plan:this.sessionPlan(t,now)})).sort((a,b)=>b.plan.score-a.plan.score||b.t.turnover-a.t.turnover);
    for(const {t,plan} of ranked){
      const block=this.entryBlock(t,now,plan);if(block){this.recordDecision(t,plan,block,now);continue;}
      const room=this.exposureLimit(this.equity())-(this.equity()-this.state.cash),order=this.sessionOrder(t,plan,this.state.cash,room,now);if(order.reason){this.recordDecision(t,plan,order.reason,now);continue;}
      this.recordFrame(t,now,true);this.fillV2(t,'BUY',plan.mode,order.fill,now,{orderAmount:order.amount,entryMode:plan.mode,kind:'morning',tradeRole:'tactical',managementRevision:15,highest:order.fill.price,stop:plan.invalidation,entryContext:{revision:15,invalidation:plan.invalidation,reserve:order.reserve,estimatedRisk:order.estimatedRisk,shape:plan.shape,setup:plan.setup,quotePrice:t.price,fillPrice:order.fill.price,sourceAt:t.sourceAt,bookAt:this.books.get(t.key)?.sourceAt,book:this.books.get(t.key)?.units?.slice(0,5),settings:structuredClone(this.strategySettings())}});this.recordDecision(t,plan,'매수 실행',now);
    }
  }
  snapshot(now=Date.now()){
    const rows=[...this.quotes.values()].map(t=>{
      const h=this.history.get(t.key)||[],base=h.findLast(v=>v.at<=now-60000),ready=!!base&&h.at(-1)?.at>=now-15000;
      const row={...t,ready,momentum:ready?t.price/base.price-1:0,stale:!this.fresh(t,now),stage:'기본',opportunityScore:0,watchlisted:this.watchlist().includes(t.market.replace(/^KRW-/,''))};
      if(t.exchange!==this.c.executionExchange)return row;
      row.quality=this.quality.status(t.key,now);const plan=this.sessionPlan(t,now);row.opportunityScore=plan.score;row.stage=plan.ready?'집중':plan.quiet?'후보':'기본';row.session={...plan};
      const root=this.state,a=root.accounts?.[t.exchange];if(a)this.state={...a,paused:root.paused,settings:root.settings,positions:Object.fromEntries(Object.entries(root.positions).filter(([,p])=>p.exchange===t.exchange))};
      try{let reason=this.entryBlock(t,now,plan);if(!reason){const order=this.sessionOrder(t,plan,this.state.cash,this.exposureLimit(this.equity(),t.exchange)-(this.equity()-this.state.cash),now);reason=order.reason||'매수 조건 충족 · 다음 평가 대기';row.session.orderAmount=order.amount??0;}row.session.decision=reason;}finally{this.state=root;}
      return row;
    });
    const reasons={};for(const t of rows.filter(t=>t.session))reasons[t.session.decision]=(reasons[t.session.decision]||0)+1;
    return {mode:'paper',now,startedAt:this.startedAt,state:this.state,equity:this.equity(),accounts:this.state.accounts?Object.fromEntries(['upbit','bithumb'].map(ex=>[ex,this.accountSnapshot(ex)])):null,markets:rows,positions:Object.entries(this.state.positions).map(([key,p])=>({...p,key,price:this.quotes.get(key)?.price??null,stale:!this.fresh(this.quotes.get(key),now),executionStale:!this.books.get(key)||now-this.books.get(key).sourceAt>1500||now-this.books.get(key).receivedAt>1500})),entryDiagnostics:{evaluated:rows.filter(t=>t.session).length,signals:rows.filter(t=>t.session?.ready).length,reasons},strategyData:{dailyReady:[],booksReady:[...this.books.entries()].filter(([,b])=>now-b.sourceAt<1500).map(([k])=>k)},telemetry:{...this.metrics,session:kstSession(now),note:'실제 체결 기반 · 수익 보장 없음'},settings:{strategies:this.strategySettings(),watchlist:this.watchlist(),retention:this.state.settings?.retention??this.c.peakProfitRetention,limits:Object.fromEntries(['upbit','bithumb'].map(ex=>[ex,this.limits(ex)]))},config:this.c,trades:this.store.trades(),events:this.store.events()};
  }

}
