import {normalizeQuote} from './exchange.js';
const URLS={upbit:'wss://api.upbit.com/websocket/v1',bithumb:'wss://ws-api.bithumb.com/websocket/v1'};
export class TickerStream {
  constructor(name,codes,onQuote,onStatus,onMarketEvent=null){this.name=name;this.codes=new Set(codes);this.onQuote=onQuote;this.onStatus=onStatus;this.onMarketEvent=onMarketEvent;this.failures=0;this.stopped=false;}
  connect(){
    if(this.stopped)return;
    this.lastMessage=Date.now();
    this.socket=new WebSocket(URLS[this.name]);this.socket.binaryType='arraybuffer';
    this.socket.addEventListener('open',()=>{
      const types=this.name==='upbit'&&this.onMarketEvent?['ticker','trade','orderbook']:['ticker'];
      this.socket.send(JSON.stringify([{ticket:crypto.randomUUID()},...types.map(type=>({type,codes:[...this.codes],is_only_realtime:true})),{format:'DEFAULT'}]));
      this.onStatus('connected');
    });
    this.socket.addEventListener('message',event=>{
      try{
        const text=typeof event.data==='string'?event.data:Buffer.from(event.data).toString('utf8');
        const t=JSON.parse(text);
        if(t.error){this.onStatus('거래소 구독 오류: '+String(t.error.name||t.error.message||'unknown').slice(0,100));this.socket.close();return;}
        if(this.codes.has(t.code)&&['trade','orderbook'].includes(t.type)){this.lastMessage=Date.now();this.onMarketEvent?.(t);return;}
        const q=normalizeQuote(this.name,t,Date.now(),true);
        if(q&&this.codes.has(q.market)){this.lastMessage=Date.now();this.failures=0;this.onQuote(q);}
      }catch{/* Invalid frames never enter the engine. */}
    });
    this.socket.addEventListener('error',()=>{this.onStatus('error');this.socket.close();});
    this.socket.addEventListener('close',()=>{
      clearInterval(this.watchdog);if(this.stopped)return;
      this.onStatus('reconnecting');this.failures++;
      this.retry=setTimeout(()=>this.connect(),Math.min(60000,2000*2**Math.min(this.failures,5)));
    });
    this.watchdog=setInterval(()=>{
      if(Date.now()-this.lastMessage>45000){this.socket.close();return;}
      if(this.socket.readyState===WebSocket.OPEN)this.socket.send('PING');
    },15000);
  }
  stop(){this.stopped=true;clearTimeout(this.retry);clearInterval(this.watchdog);this.socket?.close();}
}
