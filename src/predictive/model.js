'use strict';
const CLASSES=Object.freeze(['DOWN','SIDEWAYS','UP']);
function softmax(values){const m=Math.max(...values);const exp=values.map(v=>Math.exp(v-m));const sum=exp.reduce((a,b)=>a+b,0);return exp.map(v=>v/sum);}
function trainSoftmax(rows,options={}){
  if(!rows.length)throw new Error('No training rows');
  const dims=rows[0].x.length;
  if(!rows.every(r=>r.x.length===dims&&r.x.every(Number.isFinite)&&Number.isInteger(r.label)&&r.label>=0&&r.label<3))throw new Error('Invalid training data');
  const mean=Array.from({length:dims},(_,j)=>rows.reduce((s,r)=>s+r.x[j],0)/rows.length);
  const std=mean.map((m,j)=>Math.max(1e-8,Math.sqrt(rows.reduce((s,r)=>s+(r.x[j]-m)**2,0)/rows.length)));
  const data=rows.map(r=>[1,...r.x.map((v,j)=>Math.max(-8,Math.min(8,(v-mean[j])/std[j])))]);
  const weights=Array.from({length:3},()=>Array(dims+1).fill(0));
  const steps=Math.max(10,Math.min(1000,Number(options.steps)||250)),rate=Math.max(0.001,Math.min(0.2,Number(options.rate)||0.05));
  const lambda=Math.max(0,Number.isFinite(Number(options.regularization))?Number(options.regularization):0.002);
  for(let step=0;step<steps;step++){
    const gradient=weights.map(w=>w.map(()=>0));
    for(let i=0;i<rows.length;i++){
      const probabilities=softmax(weights.map(w=>w.reduce((s,v,j)=>s+v*data[i][j],0)));
      for(let k=0;k<3;k++)for(let j=0;j<dims+1;j++)gradient[k][j]+=(probabilities[k]-(rows[i].label===k?1:0))*data[i][j];
    }
    for(let k=0;k<3;k++)for(let j=0;j<dims+1;j++)weights[k][j]-=rate*(gradient[k][j]/rows.length+(j?lambda*weights[k][j]:0));
  }
  return {kind:'softmax-baseline-v1',classes:CLASSES,mean,std,weights,trainedSamples:rows.length};
}
function predict(model,x){
  if(model.kind!=='softmax-baseline-v1'||!Array.isArray(x)||x.length!==model.mean.length||!x.every(Number.isFinite))throw new Error('Invalid model/features');
  const scaled=[1,...x.map((v,j)=>Math.max(-8,Math.min(8,(v-model.mean[j])/model.std[j])))];
  const probabilities=softmax(model.weights.map(w=>w.reduce((s,v,j)=>s+v*scaled[j],0)));
  return Object.fromEntries(CLASSES.map((name,i)=>[name,probabilities[i]]));
}
module.exports={CLASSES,trainSoftmax,predict};
