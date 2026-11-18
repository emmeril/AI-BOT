'use strict';
// Future candles are used for training labels only, never for predictor features.
// An ambiguous intrabar event is assigned the neutral class.
function barrierOutcome(candles,index,horizon,targetPct,stopPct){
  if(index+horizon>=candles.length)return null;
  const price=candles[index].close,upper=price*(1+targetPct/100),lower=price*(1-stopPct/100);
  for(let j=index+1;j<=index+horizon;j++){
    const c=candles[j],up=c.high>=upper,down=c.low<=lower;
    if(up&&down)return {label:1,reason:'AMBIGUOUS_STOP_FIRST'};
    if(up)return {label:2,reason:'UP'};
    if(down)return {label:0,reason:'DOWN'};
  }
  return {label:1,reason:'TIMEOUT'};
}
function labeledRows(features,candles,{horizon,targetPct,stopPct}){
  if(!Number.isInteger(horizon)||horizon<1||!(targetPct>0)||!(stopPct>0))throw new Error('Invalid label config');
  return features.map(row=>{const event=barrierOutcome(candles,row.index,horizon,targetPct,stopPct);return event?{...row,label:event.label,outcome:event.reason}:null;}).filter(Boolean);
}
module.exports={barrierOutcome,labeledRows};
