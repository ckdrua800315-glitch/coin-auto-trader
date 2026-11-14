import {PublicExchange} from '../src/exchange.js';
let failed=false;
for(const name of ['upbit','bithumb']){
  try{const client=new PublicExchange(name),markets=await client.markets(),rows=await client.tickers(['KRW-BTC']);
    if(rows.length!==1 || Date.now()-rows[0].sourceAt>15000)throw Error('Missing or stale BTC ticker');
    console.log(JSON.stringify({exchange:name,krwMarkets:markets.length,market:rows[0].market,price:rows[0].price,ageMs:Date.now()-rows[0].sourceAt,checkedAt:new Date().toISOString()}));
  }catch(e){failed=true;console.error(name+': '+e.message);}
}
if(failed)process.exitCode=1;
