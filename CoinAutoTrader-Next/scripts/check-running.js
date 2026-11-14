import fs from 'node:fs';
import {config} from '../src/config.js';
import path from 'node:path';
const token=fs.readFileSync(path.join(config.dataDir,'access-token.txt'),'utf8').trim();
const res=await fetch(`http://127.0.0.1:${config.port}/api/state`,{headers:{Authorization:'Bearer '+token}});
if(!res.ok)throw Error('Dashboard HTTP '+res.status);
const s=await res.json();
const summary={checkedAt:new Date().toISOString(),mode:s.mode,markets:s.markets.length,stages:Object.fromEntries(['기본','후보','집중'].map(stage=>[stage,s.markets.filter(m=>m.stage===stage).length])),
  fresh:s.markets.filter(m=>!m.stale).length,feeds:s.feeds,paused:s.state.paused,halted:s.state.halted,equity:s.equity,positions:s.positions.length,trades:s.trades.length};
console.log(JSON.stringify(summary,null,2));
if(process.argv.includes('--save'))fs.writeFileSync(path.join(config.dataDir,'verification.json'),JSON.stringify(summary,null,2));
if(s.mode!=='paper'||s.markets.length<300||Object.values(s.feeds).some(f=>!f.lastStream||s.now-f.lastStream>45000))process.exitCode=1;
