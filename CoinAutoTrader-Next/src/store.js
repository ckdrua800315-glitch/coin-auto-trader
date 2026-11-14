import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export class Store {
  constructor(dir,initialCash) {
    this.pendingDecisions=[];this.pendingReplay=[];this.decisionTimer=null;
    fs.mkdirSync(dir,{recursive:true});
    this.db=new DatabaseSync(path.join(dir,'trader.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,exchange TEXT NOT NULL,market TEXT NOT NULL,side TEXT NOT NULL,price REAL NOT NULL,qty REAL NOT NULL,fee REAL NOT NULL,pnl REAL NOT NULL,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS hourly (market_key TEXT NOT NULL,closed_at INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(market_key,closed_at))');
    this.db.exec('CREATE TABLE IF NOT EXISTS trade_audit (trade_id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,market_key TEXT NOT NULL,json TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS replay_frames (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,market_key TEXT NOT NULL,json TEXT NOT NULL)');
    if(!this.db.prepare('SELECT id FROM state WHERE id=1').get()) this.save({cash:initialCash,positions:{},cooldowns:{},paused:false,halted:false,day:'',dayEquity:initialCash,realized:0});
  }
  read(){return JSON.parse(this.db.prepare('SELECT json FROM state WHERE id=1').get().json);}
  latestExits(){return this.db.prepare("SELECT t.* FROM trades t JOIN (SELECT MAX(id) AS id FROM trades WHERE side='SELL' GROUP BY exchange,market) x ON t.id=x.id").all();}
  hourly(){const result=new Map();for(const r of this.db.prepare('SELECT market_key,json FROM hourly ORDER BY closed_at').all()){if(!result.has(r.market_key))result.set(r.market_key,[]);result.get(r.market_key).push(JSON.parse(r.json));}return result;}
  saveHourly(key,bars,now=Date.now()){
    this.db.exec('BEGIN IMMEDIATE');try{const put=this.db.prepare('INSERT OR REPLACE INTO hourly VALUES (?,?,?)');for(const b of bars)if(b.closedAt<=now)put.run(key,b.closedAt,JSON.stringify(b));this.db.prepare('DELETE FROM hourly WHERE market_key=? AND closed_at<?').run(key,now-15*86400000);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  migrateAccounts(initialCash){
    const state=this.read();if(state.accountSchemaVersion===1)return state;
    const realized=new Map(this.db.prepare("SELECT exchange,SUM(pnl) AS pnl FROM trades WHERE side='SELL' GROUP BY exchange").all().map(r=>[r.exchange,r.pnl]));
    state.accounts={};
    for(const exchange of ['upbit','bithumb']){
      const cost=Object.values(state.positions).filter(p=>p.exchange===exchange).reduce((a,p)=>a+p.cost,0),pnl=realized.get(exchange)||0;
      state.accounts[exchange]={initialCash,cash:initialCash+pnl-cost,realized:pnl,day:'',dayEquity:initialCash,halted:!!state.halted,drawdownHalted:!!state.drawdownHalted,highWater:initialCash,baselinePending:true};
      if(state.accounts[exchange].cash<0)throw Error('Account migration would create negative cash; manual review required');
    }
    state.accountSchemaVersion=1;state.accountMigratedAt=Date.now();
    state.cash=Object.values(state.accounts).reduce((a,v)=>a+v.cash,0);state.realized=Object.values(state.accounts).reduce((a,v)=>a+v.realized,0);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.exec('CREATE TABLE IF NOT EXISTS account_migration_backup (at INTEGER PRIMARY KEY,json TEXT NOT NULL)');
      this.db.prepare('INSERT INTO account_migration_backup VALUES (?,?)').run(state.accountMigratedAt,JSON.stringify(this.read()));
      this.save(state);this.event('accounts','거래소별 초기자금 1,000만 원 독립 계좌 전환: 기존 거래 및 보유분 유지');this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return state;
  }
  save(s){this.db.prepare('INSERT OR REPLACE INTO state VALUES (1,?)').run(JSON.stringify(s));}
  commit(state,trade,audit){
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(state);
      if(trade) this.db.prepare('INSERT INTO trades(at,exchange,market,side,price,qty,fee,pnl,reason) VALUES (?,?,?,?,?,?,?,?,?)').run(...['at','exchange','market','side','price','qty','fee','pnl','reason'].map(k=>trade[k]));
      if(trade&&audit)this.db.prepare('INSERT INTO trade_audit VALUES (?,?)').run(this.db.prepare('SELECT last_insert_rowid() id').get().id,JSON.stringify(audit));
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  event(kind,message){this.db.prepare('INSERT INTO events(at,kind,message) VALUES (?,?,?)').run(Date.now(),kind,String(message).slice(0,500));}
  trades(limit=200){return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);}
  audits(){return this.db.prepare('SELECT trade_id,json FROM trade_audit ORDER BY trade_id DESC LIMIT 100').all().map(r=>({tradeId:r.trade_id,...JSON.parse(r.json)}));}
  decision(row){
    this.pendingDecisions.push(row);
    if(!this.decisionTimer)this.decisionTimer=setTimeout(()=>{try{this.flushDecisions();}catch(e){this.event('decision-log',e.message);}},250).unref();
  }
  replay(row){this.pendingReplay.push(row);if(!this.decisionTimer)this.decisionTimer=setTimeout(()=>{try{this.flushDecisions();}catch(e){this.event('replay-log',e.message);}},250).unref();}
  replayFrames(key,limit=1000){this.flushDecisions();return this.db.prepare('SELECT json FROM replay_frames WHERE market_key=? ORDER BY id DESC LIMIT ?').all(key,Math.min(5000,Math.max(1,limit))).map(r=>JSON.parse(r.json)).reverse();}
  flushDecisions(){
    clearTimeout(this.decisionTimer);this.decisionTimer=null;
    if(!this.pendingDecisions.length&&!this.pendingReplay.length)return;
    const rows=this.pendingDecisions,frames=this.pendingReplay;
    this.db.exec('BEGIN IMMEDIATE');
    try{const put=this.db.prepare('INSERT INTO decisions(at,market_key,json) VALUES (?,?,?)');for(const row of rows)put.run(row.at,row.key,JSON.stringify(row));this.db.exec('DELETE FROM decisions WHERE id <= (SELECT MAX(id)-50000 FROM decisions)');const replay=this.db.prepare('INSERT INTO replay_frames(at,market_key,json) VALUES (?,?,?)');for(const frame of frames)replay.run(frame.at,frame.key,JSON.stringify(frame));this.db.exec('DELETE FROM replay_frames WHERE id <= (SELECT MAX(id)-50000 FROM replay_frames)');this.db.exec('COMMIT');this.pendingDecisions=[];this.pendingReplay=[];}catch(e){this.db.exec('ROLLBACK');this.pendingDecisions=rows.slice(-1000);this.pendingReplay=frames.slice(-1000);throw e;}
  }
  decisions(limit=200){this.flushDecisions();return this.db.prepare('SELECT json FROM decisions ORDER BY id DESC LIMIT ?').all(Math.max(1,Math.min(1000,limit))).map(r=>JSON.parse(r.json));}
  events(){return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 30').all();}
  close(){this.flushDecisions();this.db.close();}
}
