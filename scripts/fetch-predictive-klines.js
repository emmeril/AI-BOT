#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
async function main(){
  const symbol=process.argv[2]||'BTCUSDT',days=Math.min(60,Math.max(1,Number(process.argv[3]||30)));
  if(!/^[A-Z0-9]{6,20}$/.test(symbol)||!Number.isFinite(days))
    throw new Error('Invalid symbol or days');
  const ccxt=require('ccxt');
  const exchange=new ccxt.binanceusdm({enableRateLimit:true,options:{fetchCurrencies:false}});
  const end=Date.now()-60_000;
  let since=end-days*86400000;
  const rows=[];
  while(since<end){
    const items=await exchange.fapiPublicGetKlines({symbol,interval:'1m',startTime:since,limit:1000});
    if(!items.length)break;
    for(const row of items){
      const open=Number(row[0]);
      if(open>=end)break;
      if(open>=since)rows.push(row);
    }
    const next=Number(items.at(-1)[0])+60000;
    if(next<=since)throw new Error('Binance returned no progress');
    since=next;
  }
  const {normalizeKlines}=require('../src/predictive/features');
  normalizeKlines(rows);
  const output=path.resolve('predictive-data',symbol+'-1m-'+days+'d.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(rows)+'\n',{mode:0o600});
  console.log(rows.length+' contiguous closed 1m candles saved to '+output);
}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={main};
