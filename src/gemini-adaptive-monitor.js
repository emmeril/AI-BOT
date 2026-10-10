const https = require('https');

const VALID_PROFILES = new Set(['BULLISH', 'SIDEWAYS', 'BEARISH', 'RISK_OFF']);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN',
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class GeminiRequestQueue {
  constructor(options = {}) {
    this.minimumIntervalMs = Math.max(0, Number(options.minimumIntervalMs) || 0);
    this.jitterMs = Math.max(0, Number(options.jitterMs) || 0);
    this.sleep = options.sleep || sleep;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.pending = [];
    this.running = false;
    this.lastStartedAt = 0;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const item = this.pending.shift();
        const earliest = this.lastStartedAt + this.minimumIntervalMs;
        const spacingDelay = Math.max(0, earliest - this.now());
        const jitter = this.jitterMs > 0 ? Math.floor(this.random() * (this.jitterMs + 1)) : 0;
        if (spacingDelay + jitter > 0) await this.sleep(spacingDelay + jitter);
        this.lastStartedAt = this.now();
        try {
          item.resolve(await item.task());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.pending.length) this.drain();
    }
  }
}

function isTransientGeminiError(error) {
  const statusCode = Number(error?.statusCode);
  if (statusCode === 429 || statusCode >= 500) return true;
  if (TRANSIENT_NETWORK_CODES.has(error?.code)) return true;
  return /timed?\s*out|socket hang up|network error/i.test(String(error?.message || ''));
}

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function compactAnalysis(analysis) {
  const timeframes = Object.fromEntries(Object.entries(analysis?.timeframes || {}).map(([name, value]) => [
    name,
    {
      direction: value?.direction || 'UNCERTAIN',
      score: round(value?.score),
      confidence: round(value?.confidence),
      atrPct: round(value?.atrPct),
      volatilityRatio: round(value?.volatilityRatio),
      recentMoveAtr: round(value?.recentMoveAtr),
      lastClosedAt: Number(value?.lastClosedAt) || null,
    },
  ]));
  return {
    direction: analysis?.direction || 'RANGING',
    confirmedDirection: analysis?.confirmedDirection || 'RANGING',
    score: round(analysis?.score),
    confidence: round(analysis?.confidence),
    alignment: round(analysis?.alignment),
    timeframes,
  };
}

function buildPrompt(symbol, context) {
  const payload = {
    symbol,
    strategy: {
      market: 'Binance USD-M perpetual futures',
      side: 'LONG_ONLY',
      leverage: Number(context.leverage) || null,
      marginMode: context.marginMode || null,
      gridCount: Number(context.gridCount) || null,
      rule: 'Classify risk for future BUY and refill allocation. Existing SELL exits are never changed.',
    },
    market: {
      currentPrice: round(context.currentPrice, 10),
      fibonacci: compactAnalysis(context.analysis),
    },
    inventory: {
      allocatedUsdt: round(context.allocatedUsdt),
      investmentLimitUsdt: round(context.investmentLimitUsdt),
      exposurePct: round(context.exposureRatio * 100, 2),
      positionContracts: round(context.position?.contracts, 8),
      entryPrice: round(context.position?.entryPrice, 10),
      markPrice: round(context.position?.markPrice, 10),
      liquidationPrice: round(context.position?.liquidationPrice, 10),
      unrealizedPnlUsdt: round(context.position?.unrealizedPnl),
    },
    performance: {
      realizedGridProfitUsdt: round(context.performance?.realizedGridProfit),
      feesUsdt: round(context.performance?.fees),
      fundingUsdt: round(context.performance?.funding),
    },
  };

  return `You monitor risk regimes for a live long-only futures grid bot.
Classify the conditions for NEW BUY and refill allocation only. Never suggest an order, price target, leverage change, position close, or SELL change.

Profiles:
- BULLISH: broad confirmed strength with controlled volatility.
- SIDEWAYS: ranging or mixed conditions suitable for normal grid allocation.
- BEARISH: downside conditions where the long-only bot should buy less near price and favor lower levels.
- RISK_OFF: sharp downside, volatility expansion, dangerous inventory, or liquidation proximity requiring the most conservative allocation.

Use RISK_OFF when evidence is materially dangerous, not merely because one timeframe is weak. Treat high exposure and liquidation proximity as serious risk. Return a concise reason grounded only in the supplied data.

Input:
${JSON.stringify(payload)}`;
}

function normalizeDecision(raw, options = {}) {
  const profile = String(raw?.profile || '').trim().toUpperCase();
  const confidence = Number(raw?.confidence);
  if (!VALID_PROFILES.has(profile)) throw new Error(`invalid Gemini profile: ${raw?.profile}`);
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new Error(`invalid Gemini confidence: ${raw?.confidence}`);
  }
  const minimumConfidence = Number(options.minimumConfidence) || 0.6;
  const riskFactors = Array.isArray(raw?.riskFactors)
    ? raw.riskFactors
      .filter(value => typeof value === 'string' && value.trim())
      .slice(0, 5)
      .map(value => value.trim().slice(0, 120))
    : [];
  return {
    profile,
    confidence: round(confidence),
    reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning.trim().slice(0, 500) : '',
    riskFactors,
    accepted: confidence >= minimumConfidence,
  };
}

function requestGemini({ apiKey, baseUrl, model, timeoutMs, prompt }) {
  const schema = {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        enum: [...VALID_PROFILES],
        description: 'Risk regime for future BUY and refill allocation.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence in the selected profile.',
      },
      reasoning: {
        type: 'string',
        description: 'One concise explanation grounded in the supplied data.',
      },
      riskFactors: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 5,
        description: 'Short names for the strongest risk factors.',
      },
    },
    required: ['profile', 'confidence', 'reasoning', 'riskFactors'],
    additionalProperties: false,
  };
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
      responseFormat: {
        text: { mimeType: 'APPLICATION_JSON', schema },
      },
    },
  });
  const url = `${String(baseUrl).replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-goog-api-key': apiKey,
      },
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`Gemini API returned HTTP ${response.statusCode}: ${raw.slice(0, 300)}`);
          error.statusCode = response.statusCode;
          const retryAfter = Number(response.headers?.['retry-after']);
          if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = retryAfter * 1000;
          reject(error);
          return;
        }
        try {
          const json = JSON.parse(raw);
          const text = (json?.candidates?.[0]?.content?.parts || [])
            .map(part => part.text || '')
            .join('')
            .trim();
          if (!text) throw new Error('Gemini API returned an empty response');
          resolve(JSON.parse(text.replace(/```json|```/g, '').trim()));
        } catch (error) {
          reject(new Error(`Could not parse Gemini monitor response: ${error.message}`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Gemini monitor timed out after ${timeoutMs}ms`)));
    request.once('error', reject);
    request.end(payload);
  });
}

class GeminiAdaptiveMonitor {
  constructor(options = {}) {
    this.options = {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-3.1-flash-lite',
      minimumConfidence: 0.6,
      intervalMs: 15 * 60 * 1000,
      timeoutMs: 20_000,
      minimumRequestIntervalMs: 5000,
      requestJitterMs: 250,
      maxAttempts: 3,
      retryBaseDelayMs: 2000,
      retryMaxDelayMs: 15_000,
      staleTtlMs: 60 * 60 * 1000,
      ...options,
    };
    this.cache = new Map();
    this.lastAccepted = new Map();
    this.inFlight = new Map();
    this.provider = options.provider || (input => requestGemini(input));
    this.sleep = options.sleep || sleep;
    this.requestQueue = options.requestQueue || new GeminiRequestQueue({
      minimumIntervalMs: this.options.minimumRequestIntervalMs,
      jitterMs: this.options.requestJitterMs,
      sleep: this.sleep,
      now: options.queueNow,
      random: options.random,
    });
  }

  isEnabled() {
    return Boolean(this.options.enabled && this.options.apiKey);
  }

  getDecision(symbol) {
    return this.cache.get(symbol)?.decision || null;
  }

  intervalId(now = Date.now()) {
    const intervalMs = Math.max(1, Number(this.options.intervalMs) || 1);
    return Math.floor(now / intervalMs);
  }

  async requestWithRetry(input) {
    const maximum = Math.max(1, Math.floor(Number(this.options.maxAttempts) || 1));
    let lastError;
    for (let attempt = 1; attempt <= maximum; attempt++) {
      try {
        const raw = await this.requestQueue.enqueue(() => this.provider(input));
        return { raw, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt >= maximum || !isTransientGeminiError(error)) break;
        const exponential = Math.min(
          Math.max(0, Number(this.options.retryMaxDelayMs) || 0),
          Math.max(0, Number(this.options.retryBaseDelayMs) || 0) * (2 ** (attempt - 1))
        );
        const delay = Math.max(exponential, Number(error?.retryAfterMs) || 0);
        if (delay > 0) await this.sleep(delay);
      }
    }
    throw lastError;
  }

  staleDecision(symbol, intervalId, now, error) {
    const previous = this.lastAccepted.get(symbol);
    if (!previous) return null;
    const ageMs = Math.max(0, now - previous.acceptedAt);
    if (ageMs > Math.max(0, Number(this.options.staleTtlMs) || 0)) return null;
    return {
      ...previous.decision,
      source: 'GEMINI_STALE',
      stale: true,
      staleAgeMs: ageMs,
      fallbackAt: new Date(now).toISOString(),
      decisionId: `${intervalId}:STALE:${previous.decision.profile}:${previous.decision.confidence}`,
      intervalId,
      error: String(error?.message || error).slice(0, 500),
    };
  }

  async refresh(symbol, context = {}, now = Date.now()) {
    if (!this.isEnabled()) return null;
    const intervalId = this.intervalId(now);
    const cached = this.cache.get(symbol);
    if (cached?.intervalId === intervalId) return cached.decision;
    if (this.inFlight.has(symbol)) return this.inFlight.get(symbol);

    const task = (async () => {
      try {
        const { raw, attempts } = await this.requestWithRetry({
          apiKey: this.options.apiKey,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          timeoutMs: this.options.timeoutMs,
          prompt: buildPrompt(symbol, context),
        });
        const normalized = normalizeDecision(raw, this.options);
        const decision = {
          ...normalized,
          source: 'GEMINI',
          symbol,
          model: this.options.model,
          generatedAt: new Date(now).toISOString(),
          decisionId: `${intervalId}:${normalized.profile}:${normalized.confidence}`,
          intervalId,
          attempts,
          stale: false,
          error: null,
        };
        this.cache.set(symbol, { intervalId, decision });
        if (decision.accepted) this.lastAccepted.set(symbol, { acceptedAt: now, decision });
        return decision;
      } catch (error) {
        const decision = this.staleDecision(symbol, intervalId, now, error) || {
          source: 'GEMINI_ERROR',
          symbol,
          model: this.options.model,
          generatedAt: new Date(now).toISOString(),
          decisionId: `${intervalId}:ERROR`,
          intervalId,
          accepted: false,
          profile: null,
          confidence: null,
          reasoning: '',
          riskFactors: [],
          error: String(error?.message || error).slice(0, 500),
        };
        this.cache.set(symbol, { intervalId, decision });
        return decision;
      } finally {
        this.inFlight.delete(symbol);
      }
    })();
    this.inFlight.set(symbol, task);
    return task;
  }
}

module.exports = {
  VALID_PROFILES,
  GeminiRequestQueue,
  GeminiAdaptiveMonitor,
  buildPrompt,
  isTransientGeminiError,
  normalizeDecision,
  requestGemini,
};
