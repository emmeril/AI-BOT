'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeKlines,buildFeatureRows}=require('../src/predictive/features');
const {barrierOutcome,labeledRows}=require('../src/predictive/labels');
const {trainSoftmax,predict}=require('../src/predictive/model');
const {splitChronological,tradeSummary,fitAndEvaluate}=require('../src/predictive/evaluation');
const {predictiveDecision}=require('../src/predictive/decision');
const makeRows=(n=450)=>Array.from({length:n},(_,i)=>{
  const open=100+i*0.001+Math.sin(i/8)*0.05,close=open+Math.sin(i/3)*0.01;
  return [i*60000,open,Math.max(open,close)+0.035,Math.min(open,close)-0.035,close,100,i*60000+59999,1000,20,54,540];
});
test('features never require future candles',()=>{
  const rows=makeRows(),original=normalizeKlines(rows);
  const prior=buildFeatureRows(original.slice(0,80));
  const revised=normalizeKlines(rows.map((r,i)=>i<80?r:[r[0],r[1]*1.1,r[2]*1.1,r[3]*1.1,r[4]*1.1,r[5],r[6],r[7],r[8],r[9],r[10]]));
  assert.deepEqual(prior,buildFeatureRows(revised).filter(r=>r.index<80));
});
test('invalid or missing candles reject safely',()=>{
  const rows=makeRows(40);rows.splice(10,1);
  assert.throws(()=>normalizeKlines(rows),/Invalid/);
  assert.throws(()=>normalizeKlines(makeRows(3).map((r,i)=>i===1?[...r.slice(0,10),2000]:r)),/Invalid/);
});
test('same-minute double barriers are not counted as a definite win',()=>{
  const candles=normalizeKlines(makeRows(80)).map(row=>({...row}));
  candles[31]={...candles[31],high:110,low:90};
  assert.equal(barrierOutcome(candles,30,5,0.5,0.5).reason,'AMBIGUOUS_STOP_FIRST');
});
test('chronological train, validation and holdout are purged by horizon',()=>{
  const candles=normalizeKlines(makeRows());
  const options={horizon:10,targetPct:0.1,stopPct:0.1,feePct:0.05,slippagePct:0.02};
  const rows=labeledRows(buildFeatureRows(candles),candles,options);
  const {train,validation,holdout}=splitChronological(rows,options.horizon);
  assert.ok(train.at(-1).index+options.horizon<validation[0].index);
  assert.ok(validation.at(-1).index+options.horizon<holdout[0].index);
  const model=trainSoftmax(train,{steps:15}),p=predict(model,train[0].x);
  assert.ok(Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)<1e-9);
  assert.equal(tradeSummary(model,holdout,candles,{...options,confidence:1}).trades,0);
  const result=fitAndEvaluate(rows,candles,options);
  assert.ok(result.report.metrics.holdout.samples>0);
});
test('shadow decision is no-trade when model missing or signal stale',()=>{
  assert.equal(predictiveDecision(null,null).action,'NO_TRADE');
  const model=trainSoftmax([{x:[0],label:0},{x:[1],label:1},{x:[2],label:2}],{steps:10});
  model.confidence=0.6;model.options={targetPct:1,stopPct:0.2};
  assert.equal(predictiveDecision(model,{x:[1],time:1000},{now:300000}).action,'NO_TRADE');
  assert.equal(predictiveDecision(model,{x:[1],time:1000},{now:2000}).mode,'SHADOW_ONLY');
});
