import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PriceTape,liveShape} from '../src/price-tape.js';
import {morningPlan,baseSetup,manageMorning} from '../src/morning-strategy.js';
import {PaperEngine,LiveBroker} from '../src/engine.js';import {Store} from '../src/store.js';import {config} from '../src/config.js';import {defaultStrategies,validateStrategySettings} from '../src/strategy-settings.js';
const H=3600000,now=Date.UTC(2026,10,14,22),key='upbit:KRW-TST';
const q={key,exchange:'upbit',market:'KRW-TST',price:1007,turnover:1e9,change:-.03,sourceAt:now,receivedAt:now};
const good={ready:true,probeReady:true,suspicious:false,buyRatio:.8};
function book(price=1007,at=now){return {key,sourceAt:at,receivedAt:at,units:[{ask_price:price,bid_price:price-1,ask_size:1e6,bid_size:1e6}]};}
function bars(at=now){return Array.from({length:24},(_,i)=>{const close=i<21?1000:1002+(i-21)*2;return {closedAt:Math.floor(at/H)*H-(23-i)*H,open:close,close,low:close-1,high:close+1,notional:1e7};});}
function baseRows(at=now){return Array.from({length:300},(_,i)=>{const price=i<60?1000:i<120?1000+Math.round((i-60)/6):i<180?1010-Math.round((i-120)*7/60):i<296?1005:i<298?1006:1007;const qty=i>=270?20:10;return {at:at-299000+i*1000,firstAt:at-299000+i*1000,lastAt:at-299000+i*1000,open:price,high:price,low:price,close:price,buy:price*qty*.8,sell:price*qty*.2,notional:price*qty,qty,count:1};});}
function plan(quote=q,rows=baseRows(),at=now,extra={}){return morningPlan({q:quote,rows,bars:bars(at),quality:good,book:book(quote.price,at),c:{...config,selectedStrategyModes:defaultStrategies},now:at,...extra});}
function fixture(t,settings=config){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebuilt-')),store=new Store(dir,1e7),e=new PaperEngine(store,settings);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {e,store};}
function seed(e,quote=q,rows=baseRows()){e.startedAt=quote.sourceAt-1000000;e.catalog=new Map([['upbit',new Set([quote.market])]]);e.hourly.set(quote.key,bars(quote.sourceAt));e.tape.markets.set(quote.key,rows);e.quality.status=()=>good;e.ingest([quote],quote.sourceAt);e.books.set(quote.key,book(quote.price,quote.sourceAt));}
test('only three rebuilt entry paths are selectable; obsolete strategies cannot be reactivated',()=>{
  assert.deepEqual(defaultStrategies,['base-build','open-impulse','trend-retest','hold-rising','scale-out']);
  assert.throws(()=>validateStrategySettings({selected:['intraday-breakout'],orderCap:200000,riskKrw:2000}));
  assert.throws(()=>new LiveBroker().execute(),/실전/);
});
test('real executed trades build bounded tape; quote polling alone never fabricates executions',t=>{
  const tape=new PriceTape();tape.trade(key,{trade_timestamp:now,trade_price:100,trade_volume:2,ask_bid:'BID'},now);assert.equal(tape.rows(key,now)[0].notional,200);
  tape.trade(key,{trade_timestamp:now+100,trade_price:Infinity,trade_volume:2,ask_bid:'BID'},now);assert.equal(tape.rows(key,now).length,1);
  const {e}=fixture(t);e.ingest([q],now);assert.deepEqual(e.tape.rows(key,now),[]);assert.equal(e.sessionPlan(q,now).ready,false);
});
test('completed hourly rising base qualifies, but future, gaps and falling lows cannot help',()=>{
  assert.equal(baseSetup(bars(),now).quiet,true);assert.deepEqual(baseSetup([...bars(),{closedAt:now+H,close:9999}],now),baseSetup(bars(),now));
  assert.equal(baseSetup(bars().slice(1),now).ready,false);assert.equal(baseSetup(bars().filter((_,i)=>i!==10),now).ready,false);
  assert.equal(baseSetup(bars().map((b,i)=>({...b,open:1100-i,close:1100-i,low:1099-i,high:1101-i})),now).quiet,false);
});
test('negative daily return does not exclude a real higher-low base before 09 KST',()=>{const p=plan();assert.equal(p.mode,'base-build');assert.equal(p.ready,true);assert.ok(p.shape.risingLow);});
test('SLX-style descending current prices cannot be overridden by rising hourly bars and 80 percent buy flow',()=>{
  const rows=baseRows().map((b,i)=>{const price=50.1-i*.001*4.3;return {...b,open:price,high:price,low:price,close:price};});
  const p=plan({...q,price:49},rows);assert.equal(p.ready,false);assert.equal(p.shape.falling,true);
});
test('stale tape, spoof warnings, absent fills, expensive books and deselected entries fail closed',()=>{
  assert.equal(plan(q,baseRows().slice(0,-5)).ready,false);
  assert.equal(plan(q,baseRows(),now,{quality:{...good,suspicious:true}}).ready,false);
  assert.equal(plan(q,baseRows(),now,{quality:{ready:false,probeReady:false}}).ready,false);
  assert.equal(plan(q,baseRows(),now,{book:book(1007,now-2000)}).ready,false);
  assert.equal(plan(q,baseRows(),now,{c:{...config,selectedStrategyModes:[]}}).ready,false);
});
function opening(){const boundary=Date.UTC(2026,10,15),at=boundary+5000;const rows=Array.from({length:306},(_,i)=>{const ts=boundary-300000+i*1000,price=i<300?(i%10===0?1001:1000):1002+Math.floor((i-300)/2),qty=i<300?10:100;return {at:ts,firstAt:ts,lastAt:ts,open:price,high:price,low:price,close:price,notional:price*qty,buy:price*qty*.9,sell:price*qty*.1,qty,count:1};});return {at,boundary,rows,quote:{...q,price:1004,sourceAt:at,receivedAt:at}};}
test('preobserved 09 KST launch enters after 3 seconds without a new 15 minute wait',()=>{const o=opening();assert.equal(plan(o.quote,o.rows,o.at).mode,'open-impulse');});
test('opening launch rejects missing preopen tape, failed support, excessive chase and time alone',()=>{
  const o=opening();assert.equal(plan(o.quote,o.rows.filter(b=>b.at>=o.boundary),o.at).ready,false);
  assert.equal(plan(o.quote,o.rows.map((b,i)=>i===304?{...b,low:990}:b),o.at).ready,false);
  assert.equal(plan({...o.quote,price:1040},o.rows,o.at).ready,false);
  assert.equal(plan(o.quote,o.rows,o.at,{quality:{ready:false}}).ready,false);
});
test('a BLEND-style late entry at the top cannot enter the low-base strategy',()=>{const p=plan({...q,price:1011},baseRows());assert.equal(p.ready,false);});
test('profitable position protects a feasible net floor below the old 1.74 percent activation threshold',()=>{
  const qty=100000/(183*1.0005),p={entry:183,qty,cost:100000,stop:179.64,highest:183,openedAt:now-60000,entryMode:'trend-retest'};
  const fill=price=>({price,gross:price*qty,fee:price*qty*.0005});const a=manageMorning(p,{...q,price:185},fill(185),[],config,now);
  assert.equal(a.position.profitArmed,true);assert.ok(a.position.stop>183);const b=manageMorning(a.position,{...q,price:184},fill(184),[],config,now+1000);assert.ok(b.position.stop>=a.position.stop);
});
test('stop never moves down, peak uses executable bid rather than a displayed trade high, and a gap may still lose',()=>{
  const p={entry:100,cost:10005,qty:100,highest:110,stop:105,openedAt:now-60000};const fill={price:99,gross:9900,fee:4.95};
  const r=manageMorning(p,{...q,price:999},fill,[],config,now);assert.equal(r.position.highest,110);assert.ok(r.position.stop>=105);assert.equal(r.reason,'base-invalidated');
});
test('fixed fifteen minute timeout is gone; holdings exit on invalidation even when entries are paused',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);assert.equal(store.trades()[0].side,'BUY');e.control('pause');
  const p=e.state.positions[key],at=now+900001;e.ingest([{...q,sourceAt:at,receivedAt:at}],at);e.books.set(key,book(q.price,at));e.tick(at);assert.ok(e.state.positions[key]);
  const low=p.stop-1;e.ingest([{...q,price:low,sourceAt:at+1000,receivedAt:at+1000}],at+1000);e.books.set(key,book(low,at+1000));e.tick(at+1000);assert.equal(e.state.positions[key],undefined);assert.equal(store.trades()[0].side,'SELL');
});
test('full engine records a 100k base entry with fee, gap reserve and independent accounts',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);const p=e.state.positions[key];assert.ok(p);assert.equal(p.cost,100000);assert.equal(p.entryMode,'base-build');assert.equal(e.state.accounts.upbit.cash,9900000);assert.equal(e.state.accounts.bithumb.cash,1e7);assert.ok(p.entryContext.estimatedRisk<=2000);assert.equal(store.audits()[0].managementRevision,15);assert.equal(store.decisions()[0].reason,'매수 실행');
});
test('full engine records a 09 KST launch with no hourly cache dependency',t=>{
  const {e,store}=fixture(t),o=opening();seed(e,o.quote,o.rows);e.hourly.clear();e.tick(o.at);assert.equal(store.trades()[0].reason,'open-impulse');
});
test('risk sizing cannot squeeze support to fit the budget, and wide immediate round trips are rejected',t=>{
  const {e}=fixture(t);seed(e);const p=plan();assert.equal(e.sessionOrder(q,p,1e7,1e6,now).reason,null);
  assert.match(e.sessionOrder(q,{...p,invalidation:970},1e7,1e6,now).reason,/손실 예산/);assert.match(e.sessionOrder(q,p,1e7,99999,now).reason,/한도/);
});
test('strategy migration preserves custom risk, cash, history, holdings and an explicit all-off selection',t=>{
  const {e,store}=fixture(t);const before=structuredClone(e.state);before.strategyRevision=14;before.settings.strategies={selected:['intraday-breakout'],orderCap:700000,riskKrw:3000};store.commit(before);
  const migrated=new PaperEngine(store,config);assert.equal(migrated.state.accounts.upbit.cash,before.accounts.upbit.cash);assert.equal(migrated.strategySettings().orderCap,700000);assert.equal(migrated.strategySettings().riskKrw,3000);assert.deepEqual(migrated.strategySettings().selected,defaultStrategies);
  const off=structuredClone(before);off.settings.strategies.selected=[];store.commit(off);assert.deepEqual(new PaperEngine(store,config).strategySettings().selected,[]);
});
test('empty selections and investment limits stop entries; account loss latch survives resume',t=>{
  const {e,store}=fixture(t);seed(e);e.setStrategySettings({selected:[],orderCap:200000,riskKrw:2000});e.tick(now);assert.equal(store.trades().length,0);
  e.setStrategySettings({selected:defaultStrategies,orderCap:200000,riskKrw:2000});e.setLimits({upbit:{percent:0,krw:0}});e.tick(now);assert.equal(store.trades().length,0);
  e.state.accounts.upbit.halted=true;store.commit(e.state);e.control('resume');assert.equal(new PaperEngine(store,config).state.accounts.upbit.halted,true);
});
test('manual sale is atomic and credits only its account; failed audit rolls the ledger back',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);const before=structuredClone(e.state);store.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON trade_audit BEGIN SELECT RAISE(ABORT,'fixture'); END");assert.throws(()=>e.manualSell(key,now));assert.deepEqual(e.state,before);assert.deepEqual(store.read(),before);store.db.exec('DROP TRIGGER reject_audit');e.manualSell(key,now);assert.equal(e.state.positions[key],undefined);assert.equal(e.state.accounts.bithumb.cash,1e7);assert.throws(()=>e.manualSell(key,now));
});
test('partial exit preserves proportional cost and quantities across restart',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);const p=e.state.positions[key],fill={price:1050,qty:p.qty/2,gross:p.qty/2*1050,fee:p.qty/2*1050*.0005};
  e.accountRoot=e.state;e.accountExchange='upbit';e.state={...structuredClone(e.accountRoot.accounts.upbit),positions:{[key]:p},cooldowns:{}};e.fillV2(q,'SELL','partial-profit',fill,now,{partial:true});e.state=e.accountRoot;e.accountRoot=null;e.accountExchange=null;
  const restored=new PaperEngine(store,config);assert.equal(restored.state.positions[key].cost,50000);assert.equal(restored.state.positions[key].qty,p.qty/2);assert.equal(restored.state.accounts.bithumb.cash,1e7);
});
test('a distinct rising 15 minute structure can enter a higher-low retest',()=>{
  const prefix=Array.from({length:600},(_,i)=>{const price=1000+Math.round(i*40/599),at=now-899000+i*1000;return {at,firstAt:at,lastAt:at,open:price,close:price,low:price,high:price,notional:price*10,buy:price*8,sell:price*2,qty:10,count:1};});
  const tail=baseRows().map(b=>({...b,open:b.open+17,high:b.high+17,low:b.low+17,close:b.close+17,notional:(b.close+17)*b.qty,buy:(b.close+17)*b.qty*.8,sell:(b.close+17)*b.qty*.2}));
  const p=plan({...q,price:1024},[...prefix,...tail],now,{c:{...config,selectedStrategyModes:['trend-retest']}});assert.equal(p.mode,'trend-retest');
});
test('flat tape cannot be made bullish by a mismatched ticker or a displayed buy wall',()=>{
  const rows=baseRows().map(b=>({...b,open:1000,close:1000,low:1000,high:1000}));assert.equal(plan({...q,price:1007},rows).ready,false);assert.equal(plan({...q,price:1000},rows).ready,false);
});
test('protected profitable holdings may add once, but losing holdings cannot average down',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);const at=now+60000,quote={...q,price:1030,sourceAt:at,receivedAt:at};
  const rows=baseRows(at).map(b=>({...b,open:b.open+23,high:b.high+23,low:b.low+23,close:b.close+23}));seed(e,quote,rows);e.tick(at);assert.equal(e.state.positions[key].additions,1);assert.equal(e.state.positions[key].cost,200000);assert.equal(store.trades()[0].reason,'protected-strength-add');e.tick(at);assert.equal(store.trades().filter(t=>t.side==='BUY').length,2);
});
test('maximum slots and exchange investment cap still constrain simultaneous morning signals',t=>{
  const {e,store}=fixture(t);e.setLimits({upbit:{percent:50,krw:250000}});const markets=[];
  for(let i=0;i<10;i++){const market='KRW-T'+i,quote={...q,key:'upbit:'+market,market};markets.push(market);seed(e,quote,baseRows());e.books.set(quote.key,{...book(),key:quote.key});}
  e.catalog=new Map([['upbit',new Set(markets)]]);e.tick(now);assert.equal(store.trades().length,2);assert.equal(Object.values(e.state.positions).reduce((s,p)=>s+p.cost,0),200000);assert.equal(e.state.accounts.bithumb.cash,1e7);
});
test('daily loss latch closes fresh holdings and cannot be cleared by resume',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);e.state.accounts.upbit.cash-=300000;store.commit(e.state);e.tick(now+1);assert.equal(e.state.accounts.upbit.halted,true);assert.equal(e.state.positions[key],undefined);e.control('resume');e.tick(now+2);assert.equal(e.state.accounts.upbit.halted,true);assert.equal(store.trades().filter(t=>t.side==='BUY').length,1);
});
test('entry and exit replay evidence persists with a forward-only tape and execution book',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);let frames=store.replayFrames(key);assert.equal(frames[0].revision,15);assert.equal(frames[0].initial,true);assert.ok(frames[0].tape.every(b=>b.lastAt<=frames[0].at));assert.ok(frames[0].book.units.length);
  e.control('pause');const at=now+1000;e.ingest([{...q,price:995,sourceAt:at,receivedAt:at}],at);e.books.set(key,book(995,at));e.tick(at);frames=store.replayFrames(key);assert.ok(frames.at(-1).position);assert.equal(new PaperEngine(store,config).store.replayFrames(key).length,frames.length);
});
test('a losing base never averages down even if buying flow turns strong',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);const at=now+60000,quote={...q,price:1006,sourceAt:at,receivedAt:at};seed(e,quote,baseRows(at));e.tick(at);assert.equal(store.trades().filter(t=>t.side==='BUY').length,1);assert.equal(e.state.positions[key].cost,100000);
});
test('new selection UI saves exactly the checked rebuilt strategies',async()=>{
  const vm=await import('node:vm');const {strategyCatalog}=await import('../src/strategy-settings.js');const nodes=[],ids=Object.fromEntries(['all','trend','save','status','choices','cap','risk'].map(id=>[id,{value:'',append(){}}]));let saved;
  const document={getElementById:id=>ids[id],querySelectorAll:()=>nodes.filter(v=>v.dataset?.strategy),createElement:()=>{const el={dataset:{},style:{},append(){}};nodes.push(el);return el;}};
  const context=vm.createContext({document,sessionStorage:{getItem:()=> 'fixture'},fetch:async(url,opt)=>{if(opt.method==='POST'){saved=JSON.parse(opt.body);return {ok:true,json:async()=>({settings:saved})};}return {ok:true,json:async()=>({catalog:strategyCatalog,settings:{selected:defaultStrategies,orderCap:200000,riskKrw:2000}})};}});
  await vm.runInContext(fs.readFileSync('web/strategies.js','utf8'),context);const boxes=document.querySelectorAll();assert.equal(boxes.length,5);ids.all.onclick();assert.equal(boxes.filter(v=>v.checked).length,0);ids.all.onclick();assert.equal(boxes.filter(v=>v.checked).length,5);ids.cap.value='1000000';ids.risk.value='2000';await ids.save.onclick();assert.deepEqual(saved.selected,[...defaultStrategies]);
});
test('fresh executable bids can close a broken holding even when its last trade is stale',t=>{
  const {e,store}=fixture(t);seed(e);e.tick(now);e.control('pause');const at=now+20000;e.books.set(key,book(990,at));e.tick(at);assert.equal(e.state.positions[key],undefined);assert.equal(store.trades()[0].reason,'base-invalidated');assert.ok(store.trades()[0].pnl<0);
});
