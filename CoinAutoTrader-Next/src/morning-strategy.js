import {liveShape,flow} from './price-tape.js';
import {krwTick} from './execution.js';
const H=3600000,D=86400000;
export const entryModes=['base-build','open-impulse','trend-retest'];
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
export function baseSetup(input,now){
  const h=input.filter(b=>b.closedAt<=now).sort((a,b)=>a.closedAt-b.closedAt).slice(-24),no={ready:false,quiet:false,reason:'완료 시간봉 24개 검증 대기'};
  if(h.length<24||now-h.at(-1).closedAt>H||h.some((b,i)=>!['closedAt','open','high','low','close','notional'].every(k=>Number.isFinite(b[k]))||b.closedAt%H||b.low<=0||b.high<b.open||b.high<b.close||b.low>b.open||b.low>b.close||b.notional<0||(i&&b.closedAt-h[i-1].closedAt!==H)))return no;
  const a=h.slice(-3),b=h.slice(-6,-3),last=h.at(-1),low=Math.min(...a.map(v=>v.low)),oldLow=Math.min(...b.map(v=>v.low));
  const rise=last.close/h.at(-4).close-1,vol=mean(a.map(v=>v.notional)),baseline=mean(h.slice(0,-3).map(v=>v.notional));
  const quiet=rise>=.002&&rise<=.03&&low>=oldLow&&last.close>=h.at(-2).close&&a.filter((v,i)=>v.close>=h[h.length-4+i].close).length>=2&&a.every(v=>v.high/v.low-1<=.04)&&vol>=3000000&&baseline>0&&vol/baseline>=.5;
  return {ready:true,quiet,low,oldLow,rise,hourlyBaseline:baseline,closedAt:last.closedAt,reason:quiet?'시간봉 저점 상승·완만한 매수 기반':'시간봉 매수 기반 미충족'};
}
export function morningPlan({q,rows,bars,quality,book,c,now}){
  const boundary=Math.floor(now/D)*D,elapsed=now-boundary,pre=rows.filter(b=>b.lastAt<boundary&&b.at>=boundary-300000),reference=pre.at(-1)?.close;
  const shape=liveShape(rows,q,now),setup=baseSetup(bars,now),since9=reference?q.price/reference-1:null;
  const no=reason=>({ready:false,mode:null,score:0,reason,since9,relativeFlow:shape.relative,shape,quiet:setup.quiet,hourlyReady:setup.ready});
  if(!quality||quality.suspicious)return no('실제 체결·호가 품질 확인 대기');
  if(q.turnover<c.relativeMinTurnover)return no('최소 시장 유동성 미달');
  const ask=book?.units?.[0]?.ask_price,bid=book?.units?.[0]?.bid_price;
  if(!(ask>=bid&&bid>0)||now-book.sourceAt>1500||now-book.receivedAt>1500)return no('1.5초 이내 실행 호가 대기');
  const lastTrade=rows.at(-1);if(!lastTrade||Math.abs(q.price-lastTrade.close)>krwTick(q.price)*1.01)return no('시세와 실제 체결 가격 일치 확인 대기');
  const cost=(ask-bid)/bid+2*c.fee+c.maxImpact;
  const costLimit=Math.min(.012,Math.max(.006,krwTick(q.price)/q.price*1.1+2*c.fee+c.maxImpact));
  if(cost>costLimit)return no('호가 단위 대비 실행 비용 과다');
  const allowed=mode=>c.selectedStrategyModes.includes(mode);
  const result=(mode,score,invalidation,reason)=>({ready:true,mode,score,invalidation,reason,since9,relativeFlow:shape.relative,shape,quiet:setup.quiet,hourlyReady:setup.ready,setup});
  // Pre-observed opening launch: 3 seconds of real trading above the old ceiling,
  // not a new 15-minute wait started at 09:00. Missing pre-open tape cannot be invented.
  if(allowed('open-impulse')&&elapsed>=3000&&elapsed<1800000&&pre.length>=20&&pre[0].at<=boundary-180000){
    const resistance=Math.max(...pre.map(b=>b.high)),hold=rows.filter(b=>b.at>=now-3000),f=flow(rows,now-10000,now+1),base=flow(rows,boundary-180000,boundary);
    const surge=base.notional>0?(f.notional/10)/(base.notional/180):0;
    const low=Math.min(...hold.map(b=>b.low));
    if(quality.ready&&hold.length>=3&&hold[0].at<=now-2000&&hold.every(b=>b.low>=resistance)&&q.price>=resistance+krwTick(resistance)&&since9>=.002&&since9<=.025&&f.count>=6&&f.buyRatio>=.65&&surge>=2&&shape.f5.buyRatio>=.6&&q.price>=f.vwap&&q.price/low-1<=.012)
      return result('open-impulse',Math.min(88,72+Math.floor(surge*2)),Math.min(resistance,low)*.998,'9시 이전 관찰 완료·3초 지지·실제 체결 가속');
  }
  if(!shape.ready)return no('실제 체결 기반 5분 구조 준비 중');
  if(shape.f5.buyRatio<.58||shape.f30.buyRatio<.6||!shape.aboveVwap)return no('단기 체결 우위·평균 체결가 회복 대기');
  const bounce=q.price/shape.lastLow-1;
  const hour=new Date(now+9*H).getUTCHours();
  if(allowed('base-build')&&setup.quiet&&(hour>=3&&hour<9||elapsed>=1800000)&&!shape.falling&&shape.risingLow&&shape.change>=0&&shape.width>=cost*1.5&&shape.width<=.025&&shape.location<=.7&&bounce>=Math.max(.001,cost*.6)&&bounce<=.012&&(quality.ready||quality.probeReady)&&shape.relative>=1.1)
    return result('base-build',74,shape.lastLow*.998,hour<9?'9시 전 지역 저점·실제 매수 기반 확인':'지역 저점·매수 기반 확인');
  // Pullbacks are admitted only inside a rising 15-minute structure, after a new
  // higher low. A candle close from the previous hour cannot override live selling.
  const wide=rows.filter(b=>b.at>=now-900000),older=wide.filter(b=>b.at<now-300000),recent=wide.filter(b=>b.at>=now-120000);
  if(allowed('trend-retest')&&quality.ready&&wide.length>=60&&wide[0].at<=now-840000&&older.length&&recent.length>=10&&!wide.some((b,i)=>i&&b.at-wide[i-1].at>45000)){
    const peak=Math.max(...wide.map(b=>b.high)),earlyLow=Math.min(...older.map(b=>b.low)),low=Math.min(...recent.map(b=>b.low)),draw=1-low/peak;
    const higher=shape.lastLow>=shape.priorLow&&shape.lastLow>earlyLow,qLocation=(q.price-earlyLow)/(peak-earlyLow);
    if(peak/earlyLow-1>=.015&&draw>=.005&&draw<=.03&&higher&&!shape.falling&&bounce>=Math.max(.001,cost*.6)&&bounce<=.01&&qLocation<=.65&&peak/q.price-1>=cost*2&&shape.relative>=1.2)
      return result('trend-retest',77,low*.998,'상승 구조 안의 새 높은 저점·체결 회복');
  }
  return no(shape.falling?'현재 5분 하락 우세 · 시간봉 신호로 덮어쓰지 않음':'저점 기반·시초 진입·추세 눌림 조건 대기');
}
export function manageMorning(position,q,fill,rows,c,now){
  const p={...position},shape=liveShape(rows,q,now),net=fill.gross-fill.fee;
  p.highest=Math.max(p.highest||p.entry,fill.price);
  const breakEven=p.cost/(p.qty*(1-c.fee)),tick=krwTick(p.highest),peakNet=p.highest*p.qty*(1-c.fee)-p.cost;
  const recent=rows.filter(b=>b.at>=now-60000),prior=rows.filter(b=>b.at>=now-180000&&b.at<now-60000);
  const support=prior.length?Math.min(...prior.map(b=>b.low))*.998:null;
  const weak=shape.f30.count>=6&&shape.f5.count>=2&&shape.f30.buyRatio<=.45&&shape.f5.buyRatio<=.4&&shape.f30.vwap>q.price;
  const strong=c.allowTrend!==false&&net>p.cost&&shape.ready&&!shape.falling&&shape.risingLow&&shape.aboveVwap&&shape.f30.buyRatio>=.6&&shape.f5.buyRatio>=.55;
  p.holdMode=strong?'trend-runner':'base-watch';p.tradeRole=strong?'trend':'tactical';
  p.peakNetPnl=peakNet;
  const tickNet=tick*p.qty*(1-c.fee),minimumProfit=Math.max(p.cost*.002,tickNet);
  if(peakNet>minimumProfit){
    // Keep a feasible floor even before a large percentage gain; weak buying gets
    // a tighter floor, while a runner has room for at least two normal ticks.
    const room=(strong?2:1)*tickNet,retention=Math.min(c.peakProfitRetention,weak ? .95 : strong ? .70 : .80);
    const protectedPnl=Math.max(0,Math.min(peakNet*retention,peakNet-room));
    if(protectedPnl>0){p.stop=Math.max(p.stop||0,breakEven+protectedPnl/(p.qty*(1-c.fee)));p.profitArmed=true;p.protectedPeakPnl=protectedPnl;p.effectiveRetention=protectedPnl/peakNet;p.retentionPending=p.effectiveRetention<c.peakProfitRetention;}
  }
  if(strong&&support>0&&support<fill.price)p.stop=Math.max(p.stop||0,support);
  let reason=fill.price<=p.stop?(net>p.cost?'net-profit-protect':'base-invalidated'):null;
  const age=now-p.openedAt;
  const failed=weak&&recent.length>=3&&support>0&&q.price<support;
  if(!reason&&failed&&age>=10000)reason=net>p.cost?'buying-exhausted':'entry-thesis-failed';
  // Time alone is not a sell reason. An opening entry must keep its reclaimed level.
  const level=p.entryContext?.invalidation;
  if(!reason&&p.entryMode==='open-impulse'&&age>=5000&&level>0&&fill.price<level)reason='opening-support-failed';
  const partial=!reason&&!strong&&weak&&!p.partialTaken&&net/p.cost-1>=.02;
  p.managementRevision=15;
  return {position:p,reason,partial,strong,weak,shape};
}
