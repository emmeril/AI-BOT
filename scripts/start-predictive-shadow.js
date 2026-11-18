#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path');
const {normalizeKlines,buildFeatureRows}=require('../src/predictive/features');
const {predictiveDecision}=require('../src/predictive/decision');
async function main(){
  require('dotenv').config({path:path.resolve('.env.futures'),quiet:true});
  const modelPath=path.resolve(process.env.PREDICTIVE_MODEL_PATH||'predictive-results/model.json');
  const model=JSON.parse(fs.readFileSync(modelPath,'utf8'));
  if(model.approved!==false)throw new Error('Only unapproved shadow models are accepted');
  const symbol=String(process.env.PREDICTIVE_SYMBOL||'BTCUSDT');
  if(!/^[A-Z0-9]{6,20}$/.test(symbol))throw new Error('Invalid PREDICTIVE_SYMBOL');
  const ccxt=require('ccxt');
  const exchange=new ccxt.binanceusdm({enableRateLimit:true,options:{fetchCurrencies:false}});
  const statePath=path.resolve(process.env.PREDICTIVE_SHADOW_STATE_FILE||'predictive-results/shadow.jsonl');
  fs.mkdirSync(path.dirname(statePath),{recursive:true});
  let lastTime=0,running=true;
  process.once('SIGINT',()=>{running=false;});
  process.once('SIGTERM',()=>{running=false;});
  console.log('[PREDICTIVE SHADOW] '+symbol+'; public data only; no orders');
  while(running){
    try{
      const now=Date.now();
      const raw=await exchange.fapiPublicGetKlines({symbol,interval:'1m',limit:120});
      const candles=normalizeKlines(raw.filter(row=>Number(row[6])<now));
      const feature=buildFeatureRows(candles).at(-1);
      if(feature&&feature.time!==lastTime){
        lastTime=feature.time;
        const decision=predictiveDecision(model,feature,{now,maxAgeMs:120000});
        const entry={timestamp:new Date(now).toISOString(),symbol,...decision};
        fs.appendFileSync(statePath,JSON.stringify(entry)+'\n',{mode:0o600});
        console.log(JSON.stringify(entry));
      }
    }catch(error){console.error('[PREDICTIVE SHADOW] '+error.message);}
    if(running)await new Promise(resolve=>setTimeout(resolve,60000));
  }
}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={main};
