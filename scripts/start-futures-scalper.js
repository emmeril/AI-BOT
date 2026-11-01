#!/usr/bin/env node
'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { FuturesScalperEngine } = require('../src/futures-scalper-engine');

dotenv.config({ path: path.resolve(__dirname, '..', '.env.futures'), quiet: true });

new FuturesScalperEngine().start().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
