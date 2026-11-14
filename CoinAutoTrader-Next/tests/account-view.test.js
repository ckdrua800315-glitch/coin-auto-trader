import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {root,config} from '../src/config.js';
const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8'),source=fs.readFileSync(path.join(root,'web/app.js'),'utf8');
const ids=[...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
function setup(selection='',withSession=false){
  const els=Object.fromEntries(ids.map(id=>[id,{textContent:'',innerHTML:'',value:'',style:{},setAttribute(){},classList:{add(){},remove(){}}}]));
  const context=vm.createContext({document:{getElementById:id=>{assert.ok(els[id],'Unknown element '+id);return els[id];}},sessionStorage:{getItem:()=>'',setItem(){}},localStorage:{getItem:()=>selection,setItem(){}},location:{hash:''},setTimeout(){},console});
  vm.runInContext(source,context);
  const acct=(ex,cash,value)=>({exchange:ex,initialCash:1e7,cash,holdingValue:value,holdingCost:value-100,equity:cash+value,realized:50,unrealized:100,positionCount:1});
  const market=ex=>({exchange:ex,key:ex+':KRW-BTC',market:'KRW-BTC',name:'비트코인',stage:'집중',price:100,turnover:2e9,change:0,momentum:0,sourceAt:Date.now()-60000,receivedAt:Date.now(),...(withSession&&ex==='upbit'?{session:{since9:.012,relativeFlow:3.1,quiet:true,decision:'모의 현금·투자 한도 부족'}}:{})});
  context.fixture={now:Date.now(),startedAt:0,config,state:{cash:18e6,realized:100,positions:{},paused:false},accounts:{upbit:acct('upbit',9e6,1100000),bithumb:acct('bithumb',9e6,1000000)},equity:20100000,markets:['upbit','bithumb'].map(market),positions:['upbit','bithumb'].map(ex=>({...market(ex),qty:100,entry:90,cost:9000})),trades:['upbit','bithumb'].map(ex=>({...market(ex),at:Date.now(),side:'SELL',qty:1,fee:1,pnl:50,reason:'test'})),feeds:{},events:[]};
  vm.runInContext('state=fixture;render()',context);return els;
}
test('combined view shows two separate asset/cash cards and exchange groups in every table',()=>{const e=setup();assert.match(e['account-cards'].innerHTML,/data-exchange="upbit"/);assert.match(e['account-cards'].innerHTML,/data-exchange="bithumb"/);assert.match(e['account-cards'].innerHTML,/10,100,000원/);assert.match(e['account-cards'].innerHTML,/9,000,000원/);assert.equal(e.equity.textContent,'20,100,000원');for(const id of ['positions','markets','trades']){assert.match(e[id].innerHTML,/업비트<\/th>/);assert.match(e[id].innerHTML,/빗썸<\/th>/);}});
test('single-exchange view shows own total assets and cash, not shared funds or other holdings',()=>{const e=setup('upbit');assert.equal(e.equity.textContent,'10,100,000원');assert.equal(e.cash.textContent,'9,000,000원');assert.doesNotMatch(e['account-cards'].innerHTML,/data-exchange="bithumb"/);for(const id of ['positions','markets','trades'])assert.doesNotMatch(e[id].innerHTML,/bithumb \/|빗썸<\/th>/);});
test('an old price with a recent receipt is not mislabeled as transport delay',()=>{const e=setup('upbit');assert.match(e.markets.innerHTML,/수신 확인/);assert.match(e.markets.innerHTML,/가격 1\.0분/);assert.doesNotMatch(e.markets.innerHTML,/수신 지연/);assert.match(e.markets.innerHTML,/새 체결 확인 전 신규 매수 대기/);});

test('new session diagnostics render separately from daily percent with concrete wait reason',()=>{const e=setup('upbit',true);assert.match(e.markets.innerHTML,/9시 기준 1.20%/);assert.match(e.markets.innerHTML,/상대 체결 3.1배/);assert.match(e.markets.innerHTML,/완만 상승 후보/);assert.match(e.markets.innerHTML,/모의 현금·투자 한도 부족/);});
