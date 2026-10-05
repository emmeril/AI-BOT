const https = require('https');

const VALID_PROFILES = new Set(['BULLISH', 'SIDEWAYS', 'BEARISH', 'RISK_OFF']);

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
          reject(new Error(`Gemini API returned HTTP ${response.statusCode}: ${raw.slice(0, 300)}`));
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
      ...options,
    };
    this.cache = new Map();
    this.inFlight = new Map();
    this.provider = options.provider || (input => requestGemini(input));
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

  async refresh(symbol, context = {}, now = Date.now()) {
    if (!this.isEnabled()) return null;
    const intervalId = this.intervalId(now);
    const cached = this.cache.get(symbol);
    if (cached?.intervalId === intervalId) return cached.decision;
    if (this.inFlight.has(symbol)) return this.inFlight.get(symbol);

    const task = (async () => {
      try {
        const raw = await this.provider({
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
          error: null,
        };
        this.cache.set(symbol, { intervalId, decision });
        return decision;
      } catch (error) {
        const decision = {
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
  GeminiAdaptiveMonitor,
  buildPrompt,
  normalizeDecision,
  requestGemini,
};
