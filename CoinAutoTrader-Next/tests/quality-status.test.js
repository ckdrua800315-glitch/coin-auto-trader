import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MarketQuality} from '../src/market-quality.js';
function book(at){return {sourceAt:at,receivedAt:at,units:[{ask_price:101,ask_size:1000,bid_price:100,bid_size:1000}]};}
function trade(at,id='x'){return {trade_timestamp:at,trade_price:100,trade_volume:1,ask_bid:'BID',sequential_id:id};}
test('no book, old book, no trade and warmup have distinct reasons',()=>{
  const now=Date.now(),g=new MarketQuality(),key='upbit:KRW-BTC';
  assert.equal(g.status(key,now).code,'book-pending');
  for(let i=0;i<=12;i++)g.book(key,book(now-12000+i*1000),now-12000+i*1000);
  assert.equal(g.status(key,now).code,'no-recent-trades');
  assert.equal(g.status(key,now+2000).code,'book-update-pending');
  g.trade(key,trade(now),now);assert.equal(g.status(key,now).code,'insufficient-execution');
  const fresh=new MarketQuality();fresh.book(key,book(now),now);fresh.trade(key,trade(now),now);assert.equal(fresh.status(key,now).code,'book-observation');
});
test('inactive trading is not reported as a network or orderbook delay',()=>{const now=Date.now(),g=new MarketQuality(),key='upbit:KRW-BTC';g.trade(key,trade(now-4000),now-4000);g.book(key,book(now),now);const status=g.status(key,now);assert.equal(status.code,'inactive-trading');assert.match(status.reason,/체결 뜸함/);assert.doesNotMatch(status.reason,/지연/);assert.equal(status.bookSourceAgeMs,0);assert.equal(status.lastTradeAgeMs,4000);});
