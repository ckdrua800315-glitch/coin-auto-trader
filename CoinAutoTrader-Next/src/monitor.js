import {PublicExchange} from './exchange.js';
import {TickerStream} from './stream.js';
export class Monitor {
  constructor(engine,store,config){this.engine=engine;this.store=store;this.c=config;this.running=false;this.stopping=false;this.clients=['upbit','bithumb'].map(n=>new PublicExchange(n));this.selected=new Map();this.health={};this.streams=new Map();this.lastBroad=0;this.lastCatalog=0;}
  catalog(client,catalog){
    if(!this.engine.catalog)this.engine.catalog=new Map();if(!this.marketInfo)this.marketInfo=new Map();
    const allowed=m=>(!m.market_warning||m.market_warning==='NONE')&&!m.market_event?.warning;
    this.engine.catalog.set(client.name,new Set(catalog.filter(allowed).map(m=>m.market)));
    for(const m of catalog)this.marketInfo.set(client.name+':'+m.market,{name:m.korean_name||m.market,tradeAllowed:allowed(m)});
  }
  decorate(q){return {...q,...this.marketInfo?.get(q.key)};}
  evaluate(){
    if(this.stopping)return;
    const start=Date.now();
    try{this.engine.tick(start);this.engine.metrics={...this.engine.metrics,lastDecisionAt:start,decisionComputeMs:Date.now()-start,eventWaitMs:this.pendingEventAt?start-this.pendingEventAt:null};}
    catch(e){this.store.event('engine',e.message);this.engine.control('pause');}
    this.pendingEventAt=null;
  }
  requestEvaluation(at=Date.now()){
    if(!this.c.fastEvaluation||this.stopping)return;
    if(this.evaluationTimer)return;
    this.pendingEventAt=at;
    this.evaluationTimer=setTimeout(()=>{this.evaluationTimer=null;this.evaluate();},this.c.decisionIntervalMs);
  }
  stream(name){
    const held=Object.values(this.engine.state.positions).filter(p=>p.exchange===name).map(p=>p.market);
    const watched=this.engine.watchlist().map(s=>'KRW-'+s).filter(m=>this.engine.catalog?.get(name)?.has(m));
    const codes=[...new Set([...this.selected.get(name),...held,...watched])],current=this.streams.get(name);
    if(current&&!current.stopped&&current.codes.size===codes.length&&codes.every(code=>current.codes.has(code)))return;
    current?.stop();
    const stream=new TickerStream(name,codes,q=>{
      this.engine.ingest([this.decorate(q)]);
      this.engine.metrics.lastQuoteDelayMs=Math.max(0,Date.now()-q.sourceAt);this.requestEvaluation(q.receivedAt);
      this.health[name]={...this.health[name],stream:'live',lastStream:Date.now()};
    },status=>{this.health[name]={...this.health[name],stream:status};},this.c.marketIntegrity&&name==='upbit'?t=>{
      const now=Date.now(),key=name+':'+t.code;
      if(t.type==='trade'){
        if(this.engine.quality.trade(key,t,now))this.engine.recordTrade?.(key,t,now);
        const previous=this.engine.quotes.get(key),stamp=Number(t.trade_timestamp??t.timestamp),price=Number(t.trade_price);
        if(previous&&Number.isFinite(stamp)&&stamp<=now+2000&&now-stamp<=5000&&Number.isFinite(price)&&price>0&&stamp>=previous.sourceAt){
          this.engine.ingest([{...previous,price,sourceAt:stamp,tradeAt:stamp,receivedAt:now,sourceKind:'trade-stream'}],now);
          this.engine.metrics.lastQuoteDelayMs=Math.max(0,now-stamp);
        }
      }
      if(t.type==='orderbook'){
        const book={key,sourceAt:Number(t.timestamp),receivedAt:now,units:(t.orderbook_units||[]).map(u=>Object.fromEntries(['ask_price','bid_price','ask_size','bid_size'].map(k=>[k,Number(u[k])])))};
        this.engine.quality.book(key,book,now);
        if(Number.isFinite(book.sourceAt)&&book.sourceAt<=now+2000&&now-book.sourceAt<=this.c.bookMaxAgeMs)this.engine.books.set(key,book);
      }
      const q=this.engine.quotes.get(key);if(q)q.feedReceivedAt=now;
      this.health[name]={...this.health[name],lastStream:now,stream:'live'};
      this.requestEvaluation(now);
    }:null);
    this.streams.set(name,stream);stream.connect();
  }
  async initialize(){
    await Promise.all(this.clients.map(async client=>{
      try{
        const catalog=await client.markets(this.c.fullUpbitRadar&&client.name==='upbit');
        const rows=await client.tickers(catalog.map(m=>m.market));
        const names=new Map(catalog.map(m=>[m.market,m.korean_name]));
        this.catalog(client,catalog);
        if(!this.names)this.names=new Map();for(const m of catalog)this.names.set(client.name+':'+m.market,m.korean_name||m.market);
        rows.sort((a,b)=>b.turnover-a.turnover);
        const selected=this.c.fullUpbitRadar&&client.name==='upbit'?rows:rows.slice(0,this.c.marketLimit/2);
        this.selected.set(client.name,selected.map(t=>t.market));
        this.engine.ingest(selected.map(t=>this.decorate(t)));
        this.health[client.name]={ok:true,count:this.selected.get(client.name).length,lastSuccess:Date.now()};
        this.stream(client.name);
      }catch(e){this.health[client.name]={ok:false,error:e.message};this.store.event('connection',e.message);}
    }));
    const active=new Set([...this.selected.entries()].flatMap(([ex,codes])=>codes.map(m=>ex+':'+m)));
    for(const key of this.engine.quotes.keys())if(!active.has(key)&&!this.engine.state.positions[key]){this.engine.quotes.delete(key);this.engine.history.delete(key);}
    this.lastCatalog=Date.now();
  }
  async cycle(){
    if(this.running||this.stopping)return;this.running=true;
    try{
      if(!this.selected.size||Date.now()-this.lastCatalog>(this.c.catalogMs||86400000))await this.initialize();
      const broad=Date.now()-this.lastBroad>=this.c.broadMs;
      const ranked=this.engine.snapshot().markets.filter(t=>t.stage==='집중');
      await Promise.all(this.clients.map(async client=>{
        try{
          if(!this.selected.has(client.name)){
            if(Date.now()<client.retryAt)return;
            const markets=await client.markets(this.c.fullUpbitRadar&&client.name==='upbit');const initial=await client.tickers(markets.map(m=>m.market));
            this.catalog(client,markets);
            if(!this.names)this.names=new Map();for(const m of markets)this.names.set(client.name+':'+m.market,m.korean_name||m.market);
            initial.sort((a,b)=>b.turnover-a.turnover);this.selected.set(client.name,(this.c.fullUpbitRadar&&client.name==='upbit'?initial:initial.slice(0,this.c.marketLimit/2)).map(t=>t.market));this.stream(client.name);
          }
          const watched=this.engine.watchlist().map(s=>'KRW-'+s).filter(m=>this.engine.catalog?.get(client.name)?.has(m));
          if(!this.watchSubscriptions)this.watchSubscriptions=new Map();
          const signature=watched.join(',');
          if(this.watchSubscriptions.get(client.name)!==signature){this.watchSubscriptions.set(client.name,signature);this.stream(client.name);}
          const eligible=this.c.sessionStrategyV3?this.engine.snapshot().markets.filter(t=>t.exchange===client.name).sort((a,b)=>Number(!!b.session?.ready)-Number(!!a.session?.ready)||Number(!!b.session?.quiet)-Number(!!a.session?.quiet)||b.turnover-a.turnover).slice(0,12).map(t=>t.market):this.engine.eligibleMarkets();
          if(this.c.rebuiltStrategyV15){
            const heldV2=Object.entries(this.engine.state.positions).filter(([,p])=>p.strategy&&p.exchange===client.name).map(([,p])=>p.market);
            const targets=[...new Set([...watched,...heldV2,...eligible])];
            for(let i=0;i<targets.length;i+=10)for(const book of await client.books(targets.slice(i,i+10))){
              const prior=this.engine.books.get(book.key);
              if(!prior||book.sourceAt>=prior.sourceAt)this.engine.books.set(book.key,book);
              this.engine.quality.book(book.key,book);
            }
          }
          const held=Object.values(this.engine.state.positions).filter(p=>p.exchange===client.name).map(p=>p.market);
          const targets=[...new Set([...(broad?this.selected.get(client.name):ranked.filter(t=>t.exchange===client.name).map(t=>t.market)),...held,...watched,...(client.name===this.c.executionExchange?eligible:[])])];
          if(!targets.length)return;
          const rows=await client.tickers(targets);
          const prior=this.engine.quotes;
          this.engine.ingest(rows.map(t=>this.decorate(t)));
          this.health[client.name]={...this.health[client.name],ok:true,count:this.selected.get(client.name).length,lastSuccess:Date.now(),received:rows.length};
        }catch(e){this.health[client.name]={...this.health[client.name],ok:false,error:e.message,retryAt:client.retryAt};
          if(!e.message.includes('cooldown'))this.store.event('connection',e.message);}
      }));
      if(broad)this.lastBroad=Date.now();
      this.evaluate();
    }catch(e){this.store.event('engine',e.message);this.engine.control('pause');}
    finally{this.running=false;}
  }
  async scanHourly(){
    if(this.hourlyRunning||this.stopping)return;this.hourlyRunning=true;
    try{
      this.candleClient??=new PublicExchange('upbit');this.hourlyAttempts??=new Map();
      const now=Date.now(),boundary=Math.floor(now/3600000)*3600000;
      const market=[...(this.engine.catalog?.get('upbit')||[])].sort((a,b)=>(this.hourlyAttempts.get(a)||0)-(this.hourlyAttempts.get(b)||0)).find(m=>{
        const key='upbit:'+m,bars=this.engine.hourly.get(key);return (!bars?.length||bars.at(-1).closedAt<boundary)&&now-(this.hourlyAttempts.get(m)||0)>60000;
      });
      if(market){this.hourlyAttempts.set(market,now);const bars=await this.candleClient.hourly(market);this.engine.setHourly('upbit:'+market,bars);this.engine.metrics.hourlyLastSuccessAt=Date.now();}
      this.engine.metrics.hourlyCached=this.engine.hourly.size;
      this.engine.metrics.hourlyReady=[...this.engine.hourly.keys()].filter(k=>this.engine.setup(k,Date.now()).ready).length;
      if(market)this.engine.metrics.hourlyScanError=null;
    }catch(e){this.engine.metrics.hourlyScanError=e.message;if(!this.lastHourlyErrorAt||Date.now()-this.lastHourlyErrorAt>60000){this.store.event('hourly','시간봉 수집: '+e.message);this.lastHourlyErrorAt=Date.now();}}
    finally{this.hourlyRunning=false;}
  }
  start(){this.timer=setInterval(()=>this.cycle(),this.c.focusMs);if(this.c.sessionStrategyV3)this.hourlyTimer=setInterval(()=>this.scanHourly(),this.c.hourlyScanMs);return this.cycle();}
  async stop(){this.stopping=true;clearInterval(this.timer);clearInterval(this.hourlyTimer);clearTimeout(this.evaluationTimer);for(const stream of this.streams.values())stream.stop();while(this.running||this.hourlyRunning)await new Promise(r=>setTimeout(r,50));for(const stream of this.streams.values())stream.stop();}
}
