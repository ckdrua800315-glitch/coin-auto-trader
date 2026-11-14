import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {config} from '../src/config.js';
import {executableBook} from '../src/execution.js';
import {manageMorning,morningPlan} from '../src/morning-strategy.js';
// Read-only: never replay orders into the live paper ledger.
const db=new DatabaseSync(path.join(config.dataDir,'trader.sqlite'),{readOnly:true});
const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='replay_frames'").get();
if(!exists){console.log('v1.15 재생 기록이 아직 없습니다. 수익성 검증 전입니다.');db.close();process.exit(0);}
const frames=db.prepare('SELECT json FROM replay_frames ORDER BY at,id').all().map(r=>JSON.parse(r.json));
const tapes=new Map(),results=[];
for(const f of frames){
  const tape=tapes.get(f.key)||new Map();if(f.initial)tape.clear();for(const b of f.tape)tape.set(b.at,b);for(const at of tape.keys())if(at<f.at-1800000)tape.delete(at);tapes.set(f.key,tape);
  const rows=[...tape.values()].sort((a,b)=>a.at-b.at).filter(b=>b.lastAt<=f.at);
  if(f.initial){const p=morningPlan({q:f.quote,rows,bars:f.bars,quality:f.quality,book:f.book,c:{...config,selectedStrategyModes:f.settings.selected},now:f.at});results.push({at:f.at,key:f.key,type:'entry',ready:p.ready,mode:p.mode,reason:p.reason});}
  if(f.position){const fill=executableBook(f.book,'SELL',f.position.qty,config,f.at);if(fill){const r=manageMorning(f.position,f.quote,fill,rows,{...config,...f.management},f.at);if(r.reason)results.push({at:f.at,key:f.key,type:'exit-signal',reason:r.reason,netIfSold:fill.gross-fill.fee-f.position.cost});}}
}
console.log(JSON.stringify({frames:frames.length,results,note:'기록 시점의 신호 재생입니다. 독립된 기간의 전략 수익성 백테스트가 아니며, 신호별 손익을 합산해 포트폴리오 수익으로 해석하지 마세요.'},null,2));db.close();
