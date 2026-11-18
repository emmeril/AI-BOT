'use strict';
const FEATURE_NAMES=Object.freeze(['return1','return5','return15','emaGap','rangePct','volumeRatio','flowImbalance','volatility','rangePosition']);
function normalizeKlines(rows, timeframeMs=60_000) {
  if(!Array.isArray(rows))throw new TypeError('Expected Binance klines');
  const candles=rows.map(r=>({time:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),closeTime:Number(r[6]),quoteVolume:Number(r[7]),takerBuyQuote:Number(r[10])})).sort((a,b)=>a.time-b.time);
  for(let i=0;i<candles.length;i++){
    const c=candles[i];
    if(![c.time,c.open,c.high,c.low,c.close,c.volume,c.closeTime,c.quoteVolume,c.takerBuyQuote].every(Number.isFinite)
      ||c.open<=0||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||c.low<=0||c.volume<0||c.quoteVolume<=0
      ||c.takerBuyQuote<0||c.takerBuyQuote>c.quoteVolume||c.closeTime!==c.time+timeframeMs-1
      ||(i&&c.time-candles[i-1].time!==timeframeMs))throw new Error('Invalid or non-contiguous candle at index '+i);
  }
  return candles;
}
function buildFeatureRows(candles,lookback=30){
  if(lookback<21)throw new Error('lookback must be >= 21');
  const output=[];
  for(let i=lookback;i<candles.length;i++){
    const c=candles[i],recent=candles.slice(i-20,i);
    const ret=n=>Math.log(c.close/candles[i-n].close);
    const fast=candles.slice(i-7,i+1).reduce((s,v)=>s+v.close,0)/8;
    const slow=candles.slice(i-20,i+1).reduce((s,v)=>s+v.close,0)/21;
    const avg=recent.reduce((s,v)=>s+v.quoteVolume,0)/20;
    const hi=Math.max(...recent.map(v=>v.high)),lo=Math.min(...recent.map(v=>v.low));
    const returns=recent.map((v,j)=>j?Math.log(v.close/recent[j-1].close):0);
    const mean=returns.reduce((s,v)=>s+v,0)/returns.length;
    const vol=Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/returns.length);
    const x=[ret(1),ret(5),ret(15),(fast-slow)/c.close,(c.high-c.low)/c.close,c.quoteVolume/avg-1,
      (2*c.takerBuyQuote-c.quoteVolume)/c.quoteVolume,vol,hi>lo?(c.close-lo)/(hi-lo)-0.5:0];
    if(x.every(Number.isFinite))output.push({index:i,time:c.closeTime,close:c.close,x});
  }
  return output;
}
module.exports={FEATURE_NAMES,normalizeKlines,buildFeatureRows};
