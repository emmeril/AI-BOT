const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CrossProcessMutex } = require('../src/cross-process-mutex');

test('cross-process mutex serializes work for the same key', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'futures-mutex-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const basePath = path.join(directory, 'entry');
  const first = new CrossProcessMutex(basePath, { timeoutMs: 1000, retryMs: 5 });
  const second = new CrossProcessMutex(basePath, { timeoutMs: 1000, retryMs: 5 });
  const events = [];

  await Promise.all([
    first.run('BTC/USDT:USDT', async () => {
      events.push('first-start');
      await new Promise(resolve => setTimeout(resolve, 30));
      events.push('first-end');
    }),
    second.run('BTC/USDT:USDT', async () => events.push('second')),
  ]);

  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  assert.equal(fs.existsSync(first.pathFor('BTC/USDT:USDT')), false);
});

test('cross-process mutex removes a lock owned by a dead process', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'futures-mutex-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const mutex = new CrossProcessMutex(path.join(directory, 'entry'), {
    timeoutMs: 1000,
    retryMs: 5,
  });
  const lockPath = mutex.pathFor('ETH/USDT:USDT');
  await fs.promises.writeFile(lockPath, JSON.stringify({ pid: 2147483647, token: 'stale' }));

  let ran = false;
  await mutex.run('ETH/USDT:USDT', async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('cross-process mutex preserves worker errors and still releases the lock', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'futures-mutex-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const mutex = new CrossProcessMutex(path.join(directory, 'entry'));
  const error = new Error('exchange rejected order');

  await assert.rejects(mutex.run('SOL/USDT:USDT', async () => { throw error; }), candidate => {
    assert.equal(candidate, error);
    assert.equal(candidate.crossProcessMutexAcquire, undefined);
    return true;
  });
  assert.equal(fs.existsSync(mutex.pathFor('SOL/USDT:USDT')), false);
});
