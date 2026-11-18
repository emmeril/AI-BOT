'use strict';
const {predict}=require('./model');
function predictiveDecision(model,feature,options={}){
  const now=Number(options.now??Date.now()),maxAgeMs=Number(options.maxAgeMs??120000);
  if(!model||!model.confidence||!feature||!Number.isFinite(feature.time)||
    feature.time>now||now-feature.time>maxAgeMs)
    return {action:'NO_TRADE',reason:'MODEL_UNAPPROVED_OR_STALE',mode:'SHADOW_ONLY'};
  const probabilities=predict(model,feature.x);
  const threshold=model.confidence;
  let action='NO_TRADE';
  if(probabilities.UP>=threshold&&probabilities.UP>probabilities.DOWN)action='LONG';
  else if(probabilities.DOWN>=threshold&&probabilities.DOWN>probabilities.UP)action='SHORT';
  const feePct=Number(options.feePct??0.05),slippagePct=Number(options.slippagePct??0.02);
  const reward=model.options.targetPct-2*(feePct+slippagePct);
  const risk=model.options.stopPct+2*(feePct+slippagePct);
  const netRR=reward/risk;
  if(!(reward>0&&netRR>=Number(options.minNetRr??1.5)))action='NO_TRADE';
  return {action,probabilities,candleCloseTime:feature.time,modelKind:model.kind,
    reason:action==='NO_TRADE'?'INSUFFICIENT_EDGE':'PROBABILITY_THRESHOLD_MET',
    estimatedNetRewardRisk:netRR,mode:'SHADOW_ONLY'};
}
module.exports={predictiveDecision};
