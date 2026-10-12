function normalizeGeminiApiKeys(apiKey, apiKeys = []) {
  const values = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : String(apiKeys || '').split(','))];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function retryDelayFromDetails(details) {
  const retryInfo = (Array.isArray(details) ? details : []).find(detail =>
    String(detail?.['@type'] || '').endsWith('RetryInfo')
  );
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(retryInfo?.retryDelay || '').trim());
  return match ? Math.ceil(Number(match[1]) * 1000) : 0;
}

function createGeminiHttpError(statusCode, raw, headers = {}) {
  let apiError = null;
  try {
    apiError = JSON.parse(raw)?.error || null;
  } catch {}

  const error = new Error(`Gemini API returned HTTP ${statusCode}: ${String(raw || '').slice(0, 300)}`);
  error.statusCode = Number(statusCode);
  error.apiStatus = apiError?.status || null;

  const violations = (Array.isArray(apiError?.details) ? apiError.details : [])
    .flatMap(detail => Array.isArray(detail?.violations) ? detail.violations : []);
  error.dailyQuotaExceeded = violations.some(violation =>
    /perday/i.test(String(violation?.quotaId || '')) ||
    /free_tier_requests/i.test(String(violation?.quotaMetric || ''))
  );

  const retryAfterSeconds = Number(headers?.['retry-after']);
  const headerDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1000
    : 0;
  const detailDelay = retryDelayFromDetails(apiError?.details);
  error.retryAfterMs = Math.max(headerDelay, detailDelay);
  return error;
}

function isGeminiDailyQuotaError(error) {
  return Boolean(error?.dailyQuotaExceeded);
}

class GeminiApiKeyPool {
  constructor(options = {}) {
    this.keys = normalizeGeminiApiKeys(options.apiKey, options.apiKeys);
    this.now = options.now || Date.now;
    this.defaultQuotaCooldownMs = Math.max(
      Number(options.defaultQuotaCooldownMs) || 24 * 60 * 60 * 1000,
      60 * 1000
    );
    this.blockedUntil = this.keys.map(() => 0);
    this.activeIndex = 0;
  }

  get size() {
    return this.keys.length;
  }

  availableIndex(excluded = new Set()) {
    const now = this.now();
    for (let offset = 0; offset < this.keys.length; offset++) {
      const index = (this.activeIndex + offset) % this.keys.length;
      if (!excluded.has(index) && this.blockedUntil[index] <= now) return index;
    }
    return -1;
  }

  unavailableError(lastError) {
    const now = this.now();
    const nextAvailableAt = this.blockedUntil.length ? Math.min(...this.blockedUntil) : 0;
    const waitMs = Math.max(0, nextAvailableAt - now);
    const error = new Error(
      this.keys.length
        ? `All configured Gemini API projects have exhausted their daily quota; retry in ${Math.ceil(waitMs / 1000)}s`
        : 'No Gemini API key is configured'
    );
    error.statusCode = lastError?.statusCode || 429;
    error.dailyQuotaExceeded = Boolean(this.keys.length);
    error.retryAfterMs = waitMs;
    return error;
  }

  async run(task) {
    const attempted = new Set();
    let lastError;

    while (attempted.size < this.keys.length) {
      const index = this.availableIndex(attempted);
      if (index < 0) throw this.unavailableError(lastError);
      attempted.add(index);

      try {
        const result = await task(this.keys[index], index);
        this.activeIndex = index;
        return result;
      } catch (error) {
        lastError = error;
        if (!isGeminiDailyQuotaError(error)) throw error;
        const retryAfterMs = Number(error.retryAfterMs) || 0;
        const cooldown = retryAfterMs > 0 ? retryAfterMs : this.defaultQuotaCooldownMs;
        this.blockedUntil[index] = this.now() + cooldown;
        this.activeIndex = (index + 1) % this.keys.length;
      }
    }

    throw this.unavailableError(lastError);
  }
}

module.exports = {
  GeminiApiKeyPool,
  createGeminiHttpError,
  isGeminiDailyQuotaError,
  normalizeGeminiApiKeys,
};
