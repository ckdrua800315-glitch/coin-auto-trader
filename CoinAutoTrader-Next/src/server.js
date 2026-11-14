import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {config,root} from './config.js';
import {Store} from './store.js';
import {PaperEngine} from './engine.js';
import {Monitor} from './monitor.js';
import {strategyCatalog} from './strategy-settings.js';

fs.mkdirSync(config.dataDir,{recursive:true});
const lockPath=path.join(config.dataDir,'instance.lock');
function acquire(){
  try{const fd=fs.openSync(lockPath,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const pid=Number(fs.readFileSync(lockPath,'utf8'));
    if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid lock file; inspect before removing');
    try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH'){fs.unlinkSync(lockPath);return acquire();}throw err;}
    throw Error('Another instance already owns this data directory');
  }
}
acquire();
const tokenPath=path.join(config.dataDir,'access-token.txt');
if(!fs.existsSync(tokenPath))fs.writeFileSync(tokenPath,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
const token=fs.readFileSync(tokenPath,'utf8').trim();
if(token.length<32)throw Error('Access token too short');
const store=new Store(config.dataDir,config.initialCash),engine=new PaperEngine(store,config),monitor=new Monitor(engine,store,config);
const runtime={pid:process.pid,root,dataDir:config.dataDir,entry:path.join(root,'src','server.js'),port:config.port,version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version};
const staticFiles={'/strategies':['strategies.html','text/html; charset=utf-8'],'/strategies.js':['strategies.js','text/javascript; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
function authorized(req){const input=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')||'');const expected=Buffer.from(token);return input.length===expected.length&&crypto.timingSafeEqual(input,expected);}
function json(res,code,body){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{status:'ok',mode:'paper',feeds:monitor.health});
    if(url.pathname.startsWith('/api/')){
      if(!authorized(req))return json(res,401,{error:'접속 토큰을 확인하세요.'});
      if(req.method==='GET'&&url.pathname==='/api/replay'){const key=url.searchParams.get('key')||'';if(!/^(upbit|bithumb):KRW-[A-Z0-9]+$/.test(key))return json(res,400,{error:'마켓을 선택하세요.'});return json(res,200,store.replayFrames(key));}
      if(req.method==='GET'&&url.pathname==='/api/decisions')return json(res,200,store.decisions());
      if(req.method==='GET'&&url.pathname==='/api/trade-audit')return json(res,200,store.audits());
      if(req.method==='GET'&&url.pathname==='/api/strategies')return json(res,200,{catalog:strategyCatalog,settings:engine.strategySettings()});
      if(req.method==='GET'&&url.pathname==='/api/runtime')return json(res,200,runtime);
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,{...engine.snapshot(),feeds:monitor.health});
      if(req.method==='GET'&&url.pathname==='/api/trades.csv'){
        const rows=store.trades(100000);
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="paper-trades.csv"'});
        const columns=['id','at','exchange','market','side','price','qty','fee','pnl','reason'];
        return res.end('\ufeff'+columns.join(',')+'\r\n'+rows.map(t=>columns.map(k=>JSON.stringify(t[k])).join(',')).join('\r\n'));
      }
      if(req.method==='POST'&&['/api/control','/api/watchlist','/api/limits','/api/shutdown','/api/sell','/api/retention','/api/strategies'].includes(url.pathname)){
        if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`)return json(res,403,{error:'Origin rejected'});
        if(url.pathname==='/api/shutdown'){json(res,202,{ok:true});setImmediate(shutdown);return;}
        let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)return json(res,413,{error:'Too large'});}
        const data=JSON.parse(body);
        if(url.pathname==='/api/strategies'){try{return json(res,200,{ok:true,settings:engine.setStrategySettings(data)});}catch(e){return json(res,400,{error:e.message});}}
        if(url.pathname==='/api/sell'){try{engine.manualSell(data.key);return json(res,200,{ok:true});}catch(e){return json(res,400,{error:e.message});}}
        if(url.pathname==='/api/retention'){try{return json(res,200,{ok:true,percent:engine.setRetention(data.percent)});}catch(e){return json(res,400,{error:e.message});}}
        if(url.pathname==='/api/limits'){
          try{return json(res,200,{ok:true,limits:engine.setLimits(data.limits)});}catch(e){return json(res,400,{error:e.message});}
        }
        if(url.pathname==='/api/watchlist'){
          try{return json(res,200,{ok:true,watchlist:engine.setWatchlist(data.symbols)});}catch(e){return json(res,400,{error:e.message});}
        }
        const {action}=data;if(!['pause','resume'].includes(action))return json(res,400,{error:'Invalid action'});
        engine.control(action);return json(res,200,{ok:true});
      }
      return json(res,404,{error:'Not found'});
    }
    const file=staticFiles[url.pathname];
    if(req.method==='GET'&&file){res.writeHead(200,{'Content-Type':file[1]});return res.end(fs.readFileSync(path.join(root,'web',file[0])));}
    json(res,404,{error:'Not found'});
  }catch(e){json(res,400,{error:'요청을 처리할 수 없습니다.'});}
});
server.requestTimeout=10000;server.headersTimeout=10000;
server.on('error',e=>{console.error(e.message);store.close();fs.unlinkSync(lockPath);process.exit(1);});
server.listen(config.port,config.host,()=>{
  fs.writeFileSync(path.join(config.dataDir,'runtime.json'),JSON.stringify(runtime));
  fs.writeFileSync(path.join(config.dataDir,'dashboard-url.txt'),`http://127.0.0.1:${config.port}/#${token}`);
  store.event('startup','모의매매 서버 시작');console.log(`Paper dashboard http://${config.host}:${config.port}; access link: data/dashboard-url.txt`);
  monitor.start();
});
let closing=false;
async function shutdown(){if(closing)return;closing=true;await monitor.stop();server.close(()=>{store.event('shutdown','정상 종료');store.close();fs.unlinkSync(lockPath);process.exit(0);});server.closeIdleConnections();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
