#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env.futures'), quiet: true });

const workerSpecs = [
  {
    name: 'LONG',
    script: path.join(projectRoot, 'futures-grid.js'),
    env: { ...process.env, FUTURES_POSITION_SIDE: 'LONG' },
  },
  {
    name: 'SHORT',
    script: path.join(projectRoot, 'scripts', 'start-futures-short.js'),
    env: { ...process.env },
  },
];

const workers = new Map();
let shuttingDown = false;
let exitCode = 0;
let forceStopTimer = null;

function finishWhenStopped() {
  if ([...workers.values()].some(worker => worker.exitCode === null)) return;
  if (forceStopTimer) clearTimeout(forceStopTimer);
  process.exit(exitCode);
}

function stopWorkers(signal) {
  for (const worker of workers.values()) {
    if (worker.exitCode === null) worker.kill(signal);
  }
}

function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  console.log(`[DUAL] Stopping futures workers (${signal})`);
  stopWorkers(signal);
  forceStopTimer = setTimeout(() => stopWorkers('SIGKILL'), 10000);
  finishWhenStopped();
}

for (const spec of workerSpecs) {
  const worker = spawn(process.execPath, [spec.script], {
    cwd: projectRoot,
    env: spec.env,
    stdio: 'inherit',
  });
  workers.set(spec.name, worker);
  console.log(`[DUAL] ${spec.name} worker started (PID ${worker.pid})`);
  worker.once('close', (code, signal) => {
    console.log(`[DUAL] ${spec.name} worker stopped (code=${code}, signal=${signal || 'none'})`);
    if (!shuttingDown) shutdown('SIGTERM', code || 1);
    finishWhenStopped();
  });
  worker.once('error', error => {
    console.error(`[DUAL] ${spec.name} worker failed: ${error.message}`);
    shutdown('SIGTERM', 1);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
