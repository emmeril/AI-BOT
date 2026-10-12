const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createGeminiReplay,
  loadGeminiBacktestCache,
} = require('../src/backtest-gemini-cache');

test('Gemini backtest cache replays the latest decision without future leakage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-backtest-cache-'));
  const filePath = path.join(directory, 'cache.jsonl');
  const lines = [
    {
      type: 'GEMINI_BACKTEST_META',
      schemaVersion: 1,
      promptVersion: 'market-regime-v1',
      intervalMinutes: 120,
      fixedExposurePct: 50,
      model: 'test-model',
    },
    {
      type: 'GEMINI_BACKTEST_DECISION',
      symbol: 'TEST/USDT:USDT',
      timestamp: 1_000,
      model: 'test-model',
      decision: { profile: 'BULLISH', confidence: 0.8 },
    },
    {
      type: 'GEMINI_BACKTEST_DECISION',
      symbol: 'TEST/USDT:USDT',
      timestamp: 2_000,
      model: 'test-model',
      decision: { profile: 'BEARISH', confidence: 0.9 },
    },
  ];
  fs.writeFileSync(filePath, `${lines.map(value => JSON.stringify(value)).join('\n')}\n`);

  try {
    const cache = loadGeminiBacktestCache(filePath);
    const replay = createGeminiReplay(cache, { maximumAgeMs: 1_000 });
    assert.equal(replay({ symbol: 'TEST/USDT:USDT', timestamp: 999 }), null);
    assert.equal(replay({ symbol: 'TEST/USDT:USDT', timestamp: 1_500 }).profile, 'BULLISH');
    assert.equal(replay({ symbol: 'TEST/USDT:USDT', timestamp: 2_500 }).profile, 'BEARISH');
    assert.equal(replay({ symbol: 'TEST/USDT:USDT', timestamp: 3_000 }), null);
    assert.match(cache.sha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Gemini backtest cache rejects unsupported metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-backtest-cache-'));
  const filePath = path.join(directory, 'cache.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({ type: 'GEMINI_BACKTEST_META', schemaVersion: 99 })}\n`);
  try {
    assert.throws(() => loadGeminiBacktestCache(filePath), /Unsupported or missing/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
