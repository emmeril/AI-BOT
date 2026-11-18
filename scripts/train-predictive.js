#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const {normalizeKlines,buildFeatureRows,FEATURE_NAMES}=require('../src/predictive/features');
const {labeledRows}=require('../src/predictive/labels');
const {fitAndEvaluate}=require('../src/predictive/evaluation');
function main(){
  const file=process.argv[2];
  if(!file)throw new Error('Usage: node scripts/train-predictive.js <klines.json> [output-dir]');
  const output=path.resolve(process.argv[3]||'predictive-results');
  const candles=normalizeKlines(JSON.parse(fs.readFileSync(path.resolve(file),'utf8')));
  const options={horizon:30,targetPct:0.6,stopPct:0.3,feePct:0.05,slippagePct:0.02};
  const features=buildFeatureRows(candles);
  const samples=labeledRows(features,candles,options);
  const result=fitAndEvaluate(samples,candles,options);
  const model={...result.model,featureNames:FEATURE_NAMES,trainedAt:new Date().toISOString(),approved:false};
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'model.json'),JSON.stringify(model,null,2)+'\n',{mode:0o600});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({...result.report,approvedForLive:false},null,2)+'\n');
  console.log(JSON.stringify({samples:samples.length,validation:result.report.validation,holdout:result.report.holdout,
    candidatePassedExploratoryChecks:result.report.passedExploratoryChecks,liveApproved:false,output},null,2));
}
if(require.main===module)try{main();}catch(error){console.error(error.stack||error);process.exitCode=1;}
module.exports={main};
