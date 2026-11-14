const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('harbor-token')||'',state;
let watchDirty=false,retentionDirty=false;
const dirtyLimits=new Set();
let selectedExchange=localStorage.getItem('harbor-exchange')||'';
if(!['','upbit','bithumb'].includes(selectedExchange))selectedExchange='';
const exchangeNames={upbit:'업비트',bithumb:'빗썸'};
const belongs=item=>!selectedExchange||item.exchange===selectedExchange;
if(location.hash.length>1){token=location.hash.slice(1);history.replaceState(null,'',location.pathname);sessionStorage.setItem('harbor-token',token);}
const n=v=>Number(v).toLocaleString('ko-KR',{maximumFractionDigits:4}),won=v=>n(Math.round(v))+'원',pct=v=>(v*100).toFixed(2)+'%';
const price=v=>Number(v).toLocaleString('ko-KR',{maximumFractionDigits:8})+'원';
const time=v=>new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tradeReason=v=>({'base-build':'저점 기반 탐색','open-impulse':'오전 9시 초기 상승','trend-retest':'추세 재지지','base-invalidated':'지지선 이탈','entry-thesis-failed':'매수 근거 소멸','net-profit-protect':'순수익 보호','buying-exhausted':'매수세 약화 익절','account-risk-exit':'계좌 위험 청산','protected-strength-add':'수익 보호 후 증액','opening-support-failed':'9시 지지선 이탈','partial-profit':'분할 익절','manual-sell':'수동 매도'}[v]||v);
const cell=v=>'<td>'+v+'</td>',row=values=>'<tr>'+values.map(cell).join('')+'</tr>';
const tone=v=>'<span class="'+(v>=0?'up':'down')+'">'+pct(v)+'</span>';
const age=v=>!Number.isFinite(v)?'—':v<1000?Math.max(0,Math.round(v))+'ms':v<60000?(v/1000).toFixed(1)+'초':(v/60000).toFixed(1)+'분';
function receiptCell(t,s){
  const elapsed=s.now-(t.feedReceivedAt||t.receivedAt),feed=s.feeds[t.exchange];
  if(Number.isFinite(elapsed)&&elapsed<=15000)return '<span class="receipt-ok">수신 확인 · '+age(elapsed)+'</span>';
  if(feed?.lastStream&&s.now-feed.lastStream<=45000)return '<span class="receipt-wait">연결 유지 · 종목 갱신 대기</span>';
  return '<span class="down">수신 지연 · '+age(elapsed)+'</span>';
}
function radarOrder(a,b){
  if(a.exchange!==b.exchange)return a.exchange.localeCompare(b.exchange);
  if(a.exchange==='upbit'){
    const daily=t=>Number.isFinite(t.change)?t.change:-Infinity;
    const minute=t=>t.ready&&Number.isFinite(t.momentum)?t.momentum:-Infinity;
    return (daily(b)-daily(a))||(minute(b)-minute(a))||b.turnover-a.turnover||a.market.localeCompare(b.market);
  }
  return ({집중:0,후보:1,기본:2}[a.stage]-{집중:0,후보:1,기본:2}[b.stage])||b.turnover-a.turnover;
}
function groupedRows(items,renderRow,columns,empty){
  return (selectedExchange?[selectedExchange]:['upbit','bithumb']).map(ex=>'<tr class="exchange-group"><th colspan="'+columns+'">'+exchangeNames[ex]+'</th></tr>'+(items.filter(t=>t.exchange===ex).map(renderRow).join('')||'<tr><td colspan="'+columns+'">'+exchangeNames[ex]+' '+empty+'</td></tr>')).join('');
}
function coinCell(item,names){
  const symbol=item.market.replace(/^KRW-/,''),name=names.get(item.exchange+':'+item.market)||names.get(item.market);
  const label=name&&name!==item.market&&name!==symbol?name+'('+symbol+')':symbol;
  return '<span class="coin-name">'+esc(label)+'</span><small class="coin-market">'+esc(item.exchange+' / '+item.market)+'</small>';
}
async function api(url,opts={}){const res=await fetch(url,{...opts,headers:{Authorization:'Bearer '+token,...opts.headers}});if(!res.ok){let detail='';try{detail=(await res.json()).error||'';}catch{}throw Error(res.status===401?'접속 토큰을 입력하세요.':detail||'요청 실패: '+res.status);}return res;}
function render(){
  if(!state)return;
  const s=state,positions=s.positions.filter(belongs),trades=s.trades.filter(belongs),markets=s.markets.filter(belongs),label=exchangeNames[selectedExchange]||'업비트&빗썸';
  $('runtime-update-notice').textContent=!s.config.rebuiltStrategyV15?'현재 서버는 이전 전략입니다. 전략 업데이트 적용 후 F5를 눌러주세요.':'수신 상태와 가격/체결 갱신 경과는 다릅니다. 거래가 뜸한 종목은 연결이 정상이어도 마지막 가격이 오래될 수 있습니다.';
  const accountBlocked=ex=>{const a=s.accounts?.[ex]||s.state;return a.drawdownHalted?'고점 손실 차단':a.halted?'일일 손실 차단':s.state.paused?'신규 매수 중단':'모의매매 가동';};
  const blocked=selectedExchange?accountBlocked(selectedExchange):s.state.paused?'전체 신규 매수 중단':'거래소별 상태 확인';
  const active=ex=>s.config.executionExchange===ex;
  const watchlist=s.settings?.watchlist||['BTC','ETH'];
  const investmentLimit=(ex,a)=>{const l=s.settings?.limits?.[ex]||{maxExposure:s.config.maxExposure,maxInvestedKrw:null};return Math.min(a.equity*l.maxExposure,l.maxInvestedKrw??Infinity);};
  for(const ex of ['upbit','bithumb']){
    $('limit-'+ex+'-panel').style.display=selectedExchange&&selectedExchange!==ex?'none':'';
    if(!dirtyLimits.has(ex)){const l=s.settings?.limits?.[ex]||{maxExposure:s.config.maxExposure,maxInvestedKrw:null};$('limit-'+ex+'-percent').value=String(l.maxExposure*100);$('limit-'+ex+'-krw').value=l.maxInvestedKrw===null?'':String(l.maxInvestedKrw);}
  }
  $('limits-save').disabled=!s.config.configurableLimits;
  $('limits-bithumb-save').disabled=!s.config.configurableLimits;
  if(!s.config.configurableLimits)$('limits-message').textContent='투자 한도 설정은 서버 업데이트 후 사용할 수 있습니다.';
  if(!retentionDirty)$('retention-percent').value=String(Math.round((s.settings?.retention??s.config.peakProfitRetention??.95)*100));
  $('retention-save').disabled=!s.config.manualPaperSell;
  $('strategy-open').disabled=!s.config.strategySelectorV10;
  const telemetry=s.telemetry;
  $('hourly-error').textContent=telemetry?.hourlyScanError?'시간봉 수집 오류: '+telemetry.hourlyScanError:'';
  $('latency-info').textContent=telemetry?'최근 시세 원천 나이 '+(telemetry.lastQuoteDelayMs??'—')+'ms · 최근 판단 대기 '+(telemetry.eventWaitMs??'—')+'ms · 계산 '+(telemetry.decisionComputeMs??'—')+'ms · 목표 평가 간격 '+s.config.decisionIntervalMs+'ms · 화면 갱신 '+s.config.uiRefreshMs+'ms':'지연 측정과 실시간 체결 확인은 서버 업데이트 후 표시됩니다.';
  $('morning-info').textContent=telemetry?'현재 모드: '+({preopen:'오전 3~9시 선행 기반 관찰',open:'오전 9시~9시 30분 초기 상승 관찰',normal:'일반 추세·반등 감시'}[telemetry.session]||'감시')+' · 데이터 부족 또는 의심 호가는 매수 보류':'오전 9시 특화 감시는 서버 업데이트 후 활성화됩니다.';
  $('entry-info').textContent=s.entryDiagnostics?'업비트 평가 '+s.entryDiagnostics.evaluated+'개 · 신호 '+s.entryDiagnostics.signals+'개 · '+Object.entries(s.entryDiagnostics.reasons).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([reason,count])=>reason+' '+count+'개').join(' / '):'새 매수 판단 집계는 보완 버전 재시작 후 표시됩니다.';
  if(!watchDirty)for(let i=0;i<5;i++)$('watch-'+i).value=watchlist[i]||'';
  $('watch-save').disabled=!s.config.adaptiveSizing;
  for(const [id,value] of [['view-upbit','upbit'],['view-bithumb','bithumb'],['view-all','']])$(id).setAttribute('aria-pressed',String(selectedExchange===value));
  $('view-info').textContent=label+' 화면 · 레이더 / 보유 현황 / 매수·매도 기록 / 손익';
  $('radar-title').textContent=label+' 마켓 레이더';
  $('execution-status').textContent=['upbit','bithumb'].map(ex=>exchangeNames[ex]+': '+(active(ex)?accountBlocked(ex):s.positions.some(p=>p.exchange===ex)?'감시 · 기존 보유분 청산 관리':'감시 전용 · 신규 매수 없음')).join(' / ');
  $('login').classList.add('hidden');
  const value=positions.reduce((a,p)=>a+p.qty*(p.price??p.entry),0),cost=positions.reduce((a,p)=>a+p.cost,0),realized=trades.filter(t=>t.side==='SELL').reduce((a,t)=>a+t.pnl,0);
  const account=s.accounts?.[selectedExchange],hasAccounts=!!s.accounts,visibleExchanges=selectedExchange?[selectedExchange]:['upbit','bithumb'];
  $('account-cards').innerHTML=hasAccounts?visibleExchanges.map(ex=>{const a=s.accounts[ex];return '<section class="account-card" data-exchange="'+ex+'"><h2>'+exchangeNames[ex]+' 모의 계좌</h2><div class="account-metrics"><div><small>총 자산</small><strong data-metric="equity">'+won(a.equity)+'</strong></div><div><small>사용 가능 모의 현금</small><strong data-metric="cash">'+won(a.cash)+'</strong></div><div><small>보유 평가액</small><strong>'+won(a.holdingValue)+'</strong></div><div><small>초기 모의 자산</small><strong>'+won(a.initialCash)+'</strong></div></div><p>누적 실현손익 '+won(a.realized)+' · 평가손익 '+won(a.unrealized)+'<br>초기 대비 '+won(a.equity-a.initialCash)+' · 보유 '+a.positionCount+'종목'+(a.stale?' · 지연 시세 포함':'')+'<br>'+accountBlocked(ex)+(active(ex)?'':' · 신규 매수 없음')+'</p></section>';}).join(''):'<section>거래소별 독립 계좌는 서버 재시작 후 준비됩니다. 현재 서버는 이전 공유 계좌입니다.</section>';
  $('equity-label').textContent=selectedExchange?label+' 총 자산':'두 거래소 합계 총 자산';
  $('cash-label').textContent=selectedExchange?label+' 사용 가능 모의 현금':'두 거래소 합계 모의 현금';
  $('equity').textContent=won(account?account.equity:selectedExchange?value:s.equity);$('cash').textContent=account?won(account.cash):selectedExchange?'계좌 준비 필요':won(s.state.cash);
  $('cash-note').textContent=hasAccounts?(selectedExchange?'초기 모의 자산 '+won(account.initialCash):'각 1,000만 원 · 합계 초기 자산 2,000만 원'):'독립 계좌 전환에 서버 재시작 필요';
  const names=new Map();for(const t of s.markets){if(t.name&&t.name!==t.market){names.set(t.exchange+':'+t.market,t.name);if(!names.has(t.market))names.set(t.market,t.name);}}
  $('pnl').textContent=account?'초기 대비 '+won(account.equity-account.initialCash)+' / 누적 실현 '+won(account.realized):selectedExchange?'평가손익 '+won(value-cost)+' / 최근 기록 실현 '+won(realized):'초기 대비 '+won(s.equity-s.config.initialCash*(hasAccounts?2:1))+' / 누적 실현 '+won(s.state.realized);
  $('count').textContent=markets.length+' 마켓';$('status').textContent=selectedExchange&&!active(selectedExchange)?'신규 매수 없음':blocked;
  $('stage-count').textContent='집중 '+markets.filter(t=>t.stage==='집중').length+' / 후보 '+markets.filter(t=>t.stage==='후보').length+' / 기본 '+markets.filter(t=>t.stage==='기본').length;
  $('warmup').textContent=selectedExchange&&!active(selectedExchange)?'시세 감시 · 기존 보유분 청산 관리':Date.now()-s.startedAt<s.config.warmupMs?'관찰 준비 중 · '+s.config.warmupMs/1000+'초':(s.config.adaptiveSizing?'회당 '+won(s.config.minOrderKrw)+'~':'회당 ')+won(s.config.orderKrw)+' · 최대 '+s.config.maxPositions+'종목';
  $('strategy-info').textContent='저점 기반 / 오전 9시 초기 상승 / 추세 재지지';
  if(s.config.rebuiltStrategyV15){$('morning-info').textContent='새 전략 v1.15 · 오전 3~9시 선행 기반 / 09:00~09:30 초기 상승 / 추세 재지지 · 실제 체결 자료로 판단';$('data-info').textContent='기존 매수 전략 제외 · 체결 자료는 재시작 후 수집 · 상승 지속 시 보호된 보유분만 증액';}
  if(s.config.strategySelectorV10){const st=s.settings?.strategies;$('strategy-info').textContent=st?'선택 전략 '+st.selected.length+'개 · 종목당 매수 상한 '+won(st.orderCap)+' · 주문당 예상 손실 예산 '+won(st.riskKrw)+' · 전략 설명·선택 창에서 변경':'전략 설정 준비 중';}
  $('feeds').textContent=Object.entries(s.feeds).filter(([k])=>!selectedExchange||k===selectedExchange).map(([k,v])=>exchangeNames[k]+' '+(v.ok?'정상 ('+v.count+')':'조회 재연결 대기')+' · 실시간 '+(v.lastStream&&s.now-v.lastStream<45000?'수신 중':v.stream||'대기')).join(' / ');
  $('positions').innerHTML=groupedRows(positions,p=>row([coinCell(p,names),n(p.qty),price(p.entry),p.price?price(p.price):'대기',p.price?won(p.qty*p.price-p.cost):'대기',p.strategy?(p.entryMode==='base-build'?'저점 기반':p.entryMode==='open-impulse'?'9시 초기 상승':p.entryMode==='trend-retest'?'추세 재지지':'이전 보유 관리')+' / '+price(p.stop)+(p.holdMode==='trend-runner'?' · 상승 추세 보유':'')+(p.partialTaken?' · 절반 익절 완료':'')+(p.profitArmed?' · 수익 보호 중':'')+(p.effectiveRetention>0?' · 최고 순수익 '+Math.round(p.effectiveRetention*100)+'% 보호선':'')+(p.retentionPending?' · 호가 여유에 맞춘 보호 비율 적용':''):'기존 전략',p.stale?(p.executionStale===false?'체결 시세 지연 · 매도 호가 정상':'지연 · 호가 대기'):'정상','<button data-sell-key="'+esc(p.key||p.exchange+':'+p.market)+'" '+(!s.config.manualPaperSell||(p.executionStale??p.stale)?'disabled':'')+'>현재 호가 모의매도</button>']),8,'보유 종목 없음');
  const search=$('search').value.toUpperCase();
  const marketRows=markets.filter(t=>(t.market+' '+t.name).toUpperCase().includes(search)).sort(radarOrder);
  $('markets').innerHTML=groupedRows(marketRows,t=>row(['<span class="stage">'+esc(t.stage)+'</span>',coinCell(t,names)+(t.tradeAllowed===false?'<small>투자경고 · 신규 매수 제외</small>':''),price(t.price),tone(t.change),t.ready?tone(t.momentum):'<span class="muted">관찰 중</span>',won(t.turnover),receiptCell(t,s),'<span class="muted">가격 '+age(s.now-t.sourceAt)+(t.tradeAt?' / 체결 '+age(s.now-t.tradeAt):'')+'</span>',(t.session?'<small>9시 기준 '+(t.session.since9===null?'준비 중':(t.session.since9*100).toFixed(2)+'%')+' · 상대 체결 '+(t.session.relativeFlow===null?'—':t.session.relativeFlow.toFixed(1)+'배')+(t.session.quiet?' · 완만 상승 후보':'')+'</small>'+esc(t.session.decision)+'<small>'+esc(t.quality?.reason||'')+'</small>':esc(t.quality?.reason||(s.now-t.sourceAt>15000?'새 체결 확인 전 신규 매수 대기':'확인 자료 준비 중')))]),9,'표시할 마켓 없음');
  $('trades').innerHTML=groupedRows(trades,t=>row([time(t.at),coinCell(t,names),t.side==='BUY'?'모의 매수':'모의 매도',price(t.price),n(t.qty),won(t.fee),t.side==='SELL'?won(t.pnl):'—',esc(tradeReason(t.reason))]),8,'최근 거래 없음');
  const events=s.events.filter(e=>!selectedExchange||!['upbit','bithumb'].some(ex=>ex!==selectedExchange&&e.message.includes(ex)));
  $('events').innerHTML=[...visibleExchanges,'common'].map(ex=>{const rows=events.filter(e=>ex==='common'?!['upbit','bithumb'].some(k=>e.message.includes(k)):e.message.includes(ex));return rows.length?'<li class="event-group">'+(exchangeNames[ex]||'공통 운영 기록')+'</li>'+rows.map(e=>'<li>'+esc(time(e.at)+' · '+e.message)+'</li>').join(''):'';}).join('');
  const watchQuotes=markets.filter(t=>watchlist.includes(t.market.replace(/^KRW-/,'')));
  $('watch-rows').innerHTML=groupedRows(watchQuotes,t=>{
    const a=s.accounts?.[t.exchange],score=t.opportunityScore||0,room=a?investmentLimit(t.exchange,a)-a.holdingValue:0;
    const amount=t.session?.orderAmount??0;
    const held=s.positions.some(p=>p.key===t.key),status=held?'보유 관리':!active(t.exchange)?'감시 전용':t.stale?'시세 지연':score<50?'자료·신호 준비 중':'조건 평가 중';
    return row([coinCell(t,names),price(t.price),score?score+'/100':'준비 중',!active(t.exchange)||held?'—':amount>=(s.config.minOrderKrw||100000)?won(amount):'대기',status]);
  },5,watchlist.length?'관심코인 시세 준비 중 또는 미지원 마켓':'관심코인 미지정');
  if(!s.config.adaptiveSizing&&!watchDirty)$('watch-message').textContent='관심코인 저장과 새 매수 설정은 서버 업데이트 후 사용할 수 있습니다.';
  $('export').textContent=label+' 거래 CSV';
}
async function refresh(){
  try{if(!token){$('connection').textContent='토큰 입력 필요';return;}state=await(await api('/api/state')).json();$('error').textContent='';$('connection').textContent='● 연결됨 · '+time(state.now);render();}
  catch(e){$('error').textContent=e.message;$('connection').textContent='연결 끊김 · 화면 갱신 중단';if(e.message.includes('토큰'))$('login').classList.remove('hidden');}
}
$('connect').onclick=()=>{token=$('token').value.trim();sessionStorage.setItem('harbor-token',token);refresh();};
for(const action of ['pause','resume'])$(action).onclick=async()=>{try{await api('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});await refresh();}catch(e){$('error').textContent=e.message;}};
$('export').onclick=async()=>{try{const exchange=selectedExchange,text=await(await api('/api/trades.csv')).text(),lines=text.replace(/^\ufeff/,'').split(/\r?\n/),header=lines.shift(),filtered=exchange?lines.filter(line=>{if(!line)return false;try{return JSON.parse(line.split(',')[2])===exchange;}catch{return false;}}):lines;const blob=new Blob(['\ufeff'+header+'\r\n'+filtered.join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='paper-trades-'+(exchange||'all')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$('error').textContent=e.message;}};
$('search').oninput=render;
for(const ex of ['upbit','bithumb'])for(const field of ['percent','krw'])$('limit-'+ex+'-'+field).oninput=()=>{dirtyLimits.add(ex);};
for(const [ex,id] of [['upbit','limits-save'],['bithumb','limits-bithumb-save']])$(id).onclick=async()=>{
  const button=$(id);button.disabled=true;
  try{const percent=$('limit-'+ex+'-percent').value.trim(),krw=$('limit-'+ex+'-krw').value.trim();if(!percent)throw Error('투자 비율을 입력하세요.');const limits={[ex]:{percent:Number(percent),krw:krw===''?null:Number(krw)}};await api('/api/limits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limits})});dirtyLimits.delete(ex);$('limits-message').textContent=exchangeNames[ex]+' 투자 한도를 저장했습니다. 기존 보유분은 유지합니다.';await refresh();}
  catch(e){$('limits-message').textContent=e.message;}finally{button.disabled=!state?.config.configurableLimits;}
};
for(let i=0;i<5;i++)$('watch-'+i).oninput=()=>{watchDirty=true;};
$('watch-save').onclick=async()=>{
  const button=$('watch-save');button.disabled=true;
  try{const symbols=Array.from({length:5},(_,i)=>$('watch-'+i).value.trim()).filter(Boolean);const saved=await(await api('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols})})).json();watchDirty=false;$('watch-message').textContent='저장됨: '+saved.watchlist.join(', ')+' · 시세·일봉 준비 후 집중 관리';await refresh();}
  catch(e){$('watch-message').textContent=e.message;}finally{button.disabled=!state?.config.adaptiveSizing;}
};
for(const [id,value] of [['view-upbit','upbit'],['view-bithumb','bithumb'],['view-all','']])$(id).onclick=()=>{selectedExchange=value;localStorage.setItem('harbor-exchange',value);render();};
async function loop(){await refresh();setTimeout(loop,state?.config.uiRefreshMs||2000);}loop();

$('positions').onclick=async event=>{const button=event.target.closest('button[data-sell-key]');if(!button||button.disabled)return;button.disabled=true;try{await api('/api/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:button.dataset.sellKey})});await refresh();}catch(e){$('error').textContent=e.message;button.disabled=false;}};
$('retention-percent').oninput=()=>{retentionDirty=true;};
$('retention-save').onclick=async()=>{try{await api('/api/retention',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({percent:Number($('retention-percent').value)})});retentionDirty=false;$('retention-message').textContent='보호 목표를 저장했습니다. 이미 올린 청산 기준은 낮추지 않습니다.';await refresh();}catch(e){$('retention-message').textContent=e.message;}};

$('strategy-open').onclick=()=>{const popup=window.open('/strategies','coin-strategy-settings','width=1000,height=850,scrollbars=yes');if(!popup)$('error').textContent='브라우저의 팝업 허용 후 다시 클릭하세요.';};
