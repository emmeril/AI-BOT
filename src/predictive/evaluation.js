'use strict';
const {trainSoftmax,predict}=require('./model');
function splitChronological(rows,horizon){
  if(rows.length<300)throw new Error('Need at least 300 labeled observations');
  const n=rows.length,trainEnd=Math.floor(n*0.6),validationEnd=Math.floor(n*0.8);
  if(trainEnd-horizon<40||validationEnd-trainEnd-horizon<30||n-validationEnd<30)
    throw new Error('Insufficient data after purging overlapping labels');
  return {train:rows.slice(0,trainEnd-horizon),validation:rows.slice(trainEnd,validationEnd-horizon),
    holdout:rows.slice(validationEnd),boundaries:{trainEnd:rows[trainEnd].time,validationEnd:rows[validationEnd].time}};
}
function classificationMetrics(model,rows){
  let loss=0,brier=0,correct=0;
  for(const row of rows){
    const prediction=predict(model,row.x),p=[prediction.DOWN,prediction.SIDEWAYS,prediction.UP];
    loss-=Math.log(Math.max(1e-12,p[row.label]));
    brier+=p.reduce((s,v,i)=>s+(v-(i===row.label?1:0))**2,0);
    if(p.indexOf(Math.max(...p))===row.label)correct++;
  }
  return {samples:rows.length,accuracy:correct/rows.length,logLoss:loss/rows.length,brier:brier/rows.length};
}
function tradeSummary(model,rows,candles,options){
  const {horizon,targetPct,stopPct,confidence,feePct,slippagePct}=options;
  if(![horizon,targetPct,stopPct,confidence,feePct,slippagePct].every(Number.isFinite)||
    horizon<1||targetPct<=0||stopPct<=0||confidence<0.5||confidence>1||feePct<0||slippagePct<0)
    throw new Error('Invalid simulation settings');
  let netTotal=0,wins=0,gain=0,loss=0,peak=0,maxDrawdown=0,blockUntil=-1;
  const trades=[];
  for(const row of rows){
    if(row.index<=blockUntil)continue;
    const p=predict(model,row.x);
    const side=p.UP>=confidence&&p.UP>p.DOWN?'LONG':p.DOWN>=confidence&&p.DOWN>p.UP?'SHORT':null;
    if(!side)continue;
    const entryCandle=candles[row.index+1];
    if(!entryCandle)continue;
    const direction=side==='LONG'?1:-1;
    const entry=entryCandle.open*(1+direction*slippagePct/100);
    const stop=entry*(1-direction*stopPct/100),target=entry*(1+direction*targetPct/100);
    let exit=null,reason='TIMEOUT',endIndex=Math.min(candles.length-1,row.index+horizon);
    for(let j=row.index+1;j<=endIndex;j++){
      const candle=candles[j];
      const hitStop=direction>0?candle.low<=stop:candle.high>=stop;
      const hitTarget=direction>0?candle.high>=target:candle.low<=target;
      if(hitStop){exit=stop;reason='STOP';endIndex=j;break;}
      if(hitTarget){exit=target;reason='TARGET';endIndex=j;break;}
    }
    if(exit===null)exit=candles[endIndex].close;
    const adjustedExit=exit*(1-direction*slippagePct/100);
    const net=direction*(adjustedExit/entry-1)*100-feePct*(1+adjustedExit/entry);
    netTotal+=net;
    if(net>0){wins++;gain+=net;}else loss-=net;
    peak=Math.max(peak,netTotal);
    maxDrawdown=Math.max(maxDrawdown,peak-netTotal);
    trades.push({time:row.time,side,probability:side==='LONG'?p.UP:p.DOWN,netPct:net,reason});
    blockUntil=endIndex;
  }
  return {trades:trades.length,netPct:netTotal,winRate:trades.length?wins/trades.length:0,
    profitFactor:loss>0?gain/loss:null,maxDrawdownPct:maxDrawdown,
    assumptions:{feePctPerSide:feePct,slippagePctPerSide:slippagePct,targetPct,stopPct,horizon,confidence},
    sampleTrades:trades.slice(0,20)};
}
function fitAndEvaluate(rows,candles,options){
  const split=splitChronological(rows,options.horizon),model=trainSoftmax(split.train);
  const candidates=[0.5,0.55,0.6,0.65,0.7,0.75].map(confidence=>({
    confidence,summary:tradeSummary(model,split.validation,candles,{...options,confidence})}));
  const viable=candidates.filter(item=>item.summary.trades>=10);
  viable.sort((a,b)=>b.summary.netPct-a.summary.netPct);
  const selected=viable[0],confidence=selected?.confidence??1;
  const validation=tradeSummary(model,split.validation,candles,{...options,confidence});
  const holdout=tradeSummary(model,split.holdout,candles,{...options,confidence});
  const metrics={train:classificationMetrics(model,split.train),
    validation:classificationMetrics(model,split.validation),holdout:classificationMetrics(model,split.holdout)};
  const passedExploratoryChecks=Boolean(selected&&validation.netPct>0&&holdout.netPct>0&&
    holdout.trades>=10&&holdout.profitFactor>1.1);
  return {model:{...model,confidence:confidence===1?null:confidence,
      options:{horizon:options.horizon,targetPct:options.targetPct,stopPct:options.stopPct}},
    report:{passedExploratoryChecks,selectedConfidence:confidence===1?null:confidence,
      boundaries:split.boundaries,metrics,validation,holdout,
      limitations:['Single chronological split; full walk-forward not yet implemented',
        '1m OHLC ambiguity uses conservative stop first',
        'Funding, liquidation, order-book history and network latency excluded',
        'Holdout success is research evidence only; shadow forward test still required']}};
}
module.exports={splitChronological,classificationMetrics,tradeSummary,fitAndEvaluate};
