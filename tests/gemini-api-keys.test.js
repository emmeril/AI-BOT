const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GeminiApiKeyPool,
  createGeminiHttpError,
  isGeminiDailyQuotaError,
  normalizeGeminiApiKeys,
} = require('../src/gemini-api-keys');

test('Gemini API keys are trimmed and deduplicated', () => {
  assert.deepEqual(
    normalizeGeminiApiKeys('primary', [' secondary ', 'primary', '', 'third']),
    ['primary', 'secondary', 'third']
  );
});

test('Gemini daily quota errors include the provider retry delay', () => {
  const raw = JSON.stringify({
    error: {
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          }],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.RetryInfo',
          retryDelay: '61244.25s',
        },
      ],
    },
  });

  const error = createGeminiHttpError(429, raw);
  assert.equal(isGeminiDailyQuotaError(error), true);
  assert.equal(error.retryAfterMs, 61_244_250);
});

test('Gemini key pool fails over after a project exhausts daily quota', async () => {
  const pool = new GeminiApiKeyPool({ apiKeys: ['account-a', 'account-b'] });
  const calls = [];

  const result = await pool.run(async apiKey => {
    calls.push(apiKey);
    if (apiKey === 'account-a') {
      const error = new Error('daily quota exhausted');
      error.statusCode = 429;
      error.dailyQuotaExceeded = true;
      error.retryAfterMs = 60_000;
      throw error;
    }
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['account-a', 'account-b']);
});

test('Gemini key pool does not call quota-blocked projects again', async () => {
  let now = 1_000;
  const pool = new GeminiApiKeyPool({
    apiKeys: ['account-a', 'account-b'],
    now: () => now,
  });
  let calls = 0;
  const fail = async () => {
    calls += 1;
    const error = new Error('daily quota exhausted');
    error.statusCode = 429;
    error.dailyQuotaExceeded = true;
    error.retryAfterMs = 60_000;
    throw error;
  };

  await assert.rejects(pool.run(fail), /All configured Gemini API projects/);
  assert.equal(calls, 2);
  await assert.rejects(pool.run(fail), /retry in 60s/);
  assert.equal(calls, 2);

  now += 60_000;
  await assert.rejects(pool.run(fail), /All configured Gemini API projects/);
  assert.equal(calls, 4);
});
