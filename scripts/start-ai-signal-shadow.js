#!/usr/bin/env node
'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { AiSignalShadowService } = require('../src/ai-signal/shadow-service');

dotenv.config({ path: path.resolve(__dirname, '..', '.env.futures'), quiet: true });

const service = new AiSignalShadowService();
process.once('SIGINT', () => service.stop());
process.once('SIGTERM', () => service.stop());

service.start().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
