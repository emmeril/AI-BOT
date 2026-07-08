const fs = require('fs');
const https = require('https');
const {
  GEMINI_RANGE_ADVISOR_ENABLED,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GEMINI_API_BASE_URL,
  GEMINI_RANGE_ADVISOR_TIMEFRAME,
  GEMINI_RANGE_ADVISOR_TIMEFRAME_MS,
  GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS,
  GEMINI_RANGE_ADVISOR_CANDLE_LIMIT,
  GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT,
  GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT,
  GEMINI_RANGE_ADVISOR_TIMEOUT_MS,
  GEMINI_RANGE_ADVISOR_STATE_PATH
} = require('./config');
const { AtomicFileWriter } = require('./atomic-file-writer');
const { retry, roundNumber, isPlainObject, withTimeout } = require('./utils');

//
// Re-evaluated every cycle (cheap local checks), but only actually calls the
// Gemini API right after a new exchange candle closes for GEMINI_RANGE_ADVISOR_TIMEFRAME
// (epoch-aligned boundaries, e.g. on the hour for '1h'), to avoid burning API
// quota/cost on tight INTERVAL_MINUTES.
//
// Pipeline per symbol:
//   1. fetchOHLCV (ccxt)              -> candle history
//   2. computeIndicators (pure JS)    -> RSI(14), ATR(14), Bollinger Bands(20,2)
//   3. Gemini API -> { lower, upper, confidence, reasoning }
//   4. Sanity clamp vs. current price / max shift % / min confidence
//   5. Cache result; SpotGridEngine.buildRange() consumes the cached suggestion.
class TechnicalIndicators {
  static rsi(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return roundNumber(100 - 100 / (1 + rs), 2);
  }

  static atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const [, , high, low] = candles[i];
      const prevClose = candles[i - 1][4];
      trueRanges.push(Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      ));
    }
    const lastN = trueRanges.slice(-period);
    const atr = lastN.reduce((a, b) => a + b, 0) / lastN.length;
    return roundNumber(atr, 8);
  }

  static bollinger(closes, period = 20, stdDevMultiplier = 2) {
    if (closes.length < period) return null;
    const window = closes.slice(-period);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      middle: roundNumber(mean, 8),
      upper: roundNumber(mean + stdDevMultiplier * stdDev, 8),
      lower: roundNumber(mean - stdDevMultiplier * stdDev, 8),
      stdDev: roundNumber(stdDev, 8),
    };
  }

  static volatilityPct(candles) {
    if (!candles.length) return null;
    const closes = candles.map(c => c[4]);
    const high = Math.max(...closes);
    const low = Math.min(...closes);
    if (low <= 0) return null;
    return roundNumber(((high - low) / low) * 100, 2);
  }
}

class GeminiRangeAdvisor {
  constructor(exchange) {
    this.exchange = exchange;
    this.cache = this.loadCache();
  }

  loadCache() {
    try {
      if (fs.existsSync(GEMINI_RANGE_ADVISOR_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(GEMINI_RANGE_ADVISOR_STATE_PATH, 'utf8')) || {};
      }
    } catch (err) {
      console.warn('[GEMINI] Failed to read advisor cache, starting fresh:', err.message);
    }
    return {};
  }

  async saveCache() {
    await AtomicFileWriter.write(GEMINI_RANGE_ADVISOR_STATE_PATH, () => JSON.stringify(this.cache, null, 2));
  }

  isEnabled() {
    return GEMINI_RANGE_ADVISOR_ENABLED && Boolean(GEMINI_API_KEY);
  }

  /**
   * Returns the cached/fresh suggestion for a symbol, or null if disabled,
   * not yet due for refresh, or the last attempt failed.
   * This is cheap to call every cycle: it only triggers a real Gemini call
   * right after a new exchange candle closes for GEMINI_RANGE_ADVISOR_TIMEFRAME
   * (epoch-aligned, e.g. every hour on the hour for '1h'), instead of on an
   * arbitrary rolling clock started from whenever the bot happened to boot.
   */
  async getSuggestion(symbol, currentPrice) {
    if (!this.isEnabled()) return null;
    const entry = this.cache[symbol];
    const now = Date.now();
    const currentBoundary = Math.floor(now / GEMINI_RANGE_ADVISOR_TIMEFRAME_MS) * GEMINI_RANGE_ADVISOR_TIMEFRAME_MS;
    const readyAt = currentBoundary + GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_MS;
    const lastBoundary = entry?.candleBoundary ?? -1;
    const due = now >= readyAt && currentBoundary > lastBoundary;
    if (!due) return entry?.suggestion || null;

    try {
      const suggestion = await this.computeSuggestion(symbol, currentPrice);
      this.cache[symbol] = { fetchedAt: now, candleBoundary: currentBoundary, suggestion };
      await this.saveCache();
      return suggestion;
    } catch (err) {
      console.warn(`[GEMINI] ${symbol} range advisor failed, keeping previous suggestion:`, err.message);
      // Keep stale suggestion (if any) but stamp the boundary so we don't
      // hammer the API every cycle while it's failing; retry on the next
      // candle close instead.
      if (entry) {
        entry.fetchedAt = now;
        entry.candleBoundary = currentBoundary;
      } else {
        this.cache[symbol] = { fetchedAt: now, candleBoundary: currentBoundary, suggestion: null, lastError: err.message };
      }
      await this.saveCache();
      return entry?.suggestion || null;
    }
  }

  async computeSuggestion(symbol, currentPrice) {
    const candles = await retry(() => this.exchange.fetchOHLCV(
      symbol,
      GEMINI_RANGE_ADVISOR_TIMEFRAME,
      undefined,
      GEMINI_RANGE_ADVISOR_CANDLE_LIMIT
    ));
    if (!Array.isArray(candles) || candles.length < 20) {
      throw new Error(`insufficient candle history (${candles?.length || 0})`);
    }
    const closes = candles.map(c => c[4]);
    const indicators = {
      rsi14: TechnicalIndicators.rsi(closes, 14),
      atr14: TechnicalIndicators.atr(candles, 14),
      bollinger20: TechnicalIndicators.bollinger(closes, 20, 2),
      volatilityPct: TechnicalIndicators.volatilityPct(candles),
      candleCount: candles.length,
      timeframe: GEMINI_RANGE_ADVISOR_TIMEFRAME,
    };

    const raw = await this.callGemini(symbol, currentPrice, indicators);
    return this.sanitizeSuggestion(symbol, currentPrice, raw);
  }

  buildPrompt(symbol, priceOrContext, indicators = {}) {
    const context = isPlainObject(priceOrContext)
      ? priceOrContext
      : { currentPrice: priceOrContext };
    const currentPrice = Number(context.currentPrice);
    const trailingUpJustShifted = Boolean(context.trailingUpJustShifted);
    const trailingDownJustShifted = Boolean(context.trailingDownJustShifted);

    return `You are a quantitative trading assistant advising a SPOT GRID TRADING bot (buy low / sell high within a fixed price range).
Grid bots perform best when the price range tightly matches realistic near-term price action (ranging/sideways market), and perform badly if the price breaks far outside the range or if the market is strongly trending.

Symbol: ${symbol}
Current price: ${currentPrice}
Current grid range: ${context.lower ?? 'unknown'}-${context.upper ?? 'unknown'}
Timeframe analyzed: ${indicators.timeframe} (${indicators.candleCount} candles)
RSI(14): ${indicators.rsi14}
ATR(14): ${indicators.atr14}
Bollinger Bands(20,2): lower=${indicators.bollinger20?.lower}, middle=${indicators.bollinger20?.middle}, upper=${indicators.bollinger20?.upper}
Recent range volatility: ${indicators.volatilityPct}%
Trailing Up Just Shifted: ${trailingUpJustShifted}
Trailing Down Just Shifted: ${trailingDownJustShifted}

${trailingUpJustShifted ? 'Do not block solely because price is near the new upper bound immediately after a completed trailing-up shift.' : ''}
${trailingDownJustShifted ? 'Do not block solely because price is near the new lower bound immediately after a completed trailing-down shift.' : ''}

Based on all of this, recommend a grid trading price range (lower and upper bound) that is appropriate for the next few hours to a day, and assess whether current conditions favor grid trading (ranging) or disfavor it (strongly trending, about to break out).

Minimum range width requirement: the recommended range MUST span at least ${GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}% of the current price (i.e. upper - lower >= ${GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT}% * ${currentPrice}). Do not recommend a narrower range even if volatility appears very low; widen the range as needed to meet this minimum.

Respond with ONLY a single valid JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "lower": <number>,
  "upper": <number>,
  "confidence": <number between 0 and 1>,
  "marketCondition": "<RANGING|TRENDING_UP|TRENDING_DOWN|VOLATILE|UNCERTAIN>",
  "reasoning": "<short 1-2 sentence explanation>"
}`;
  }

  async callGemini(symbol, currentPrice, indicators) {
    const prompt = this.buildPrompt(symbol, currentPrice, indicators);
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    };
    const payload = JSON.stringify(body);
    // API key is sent via the x-goog-api-key header instead of the URL query
    // string. Query strings are commonly written to access logs, reverse-proxy
    // logs, and error messages (e.g. this function's own HTTP-status error
    // includes response text, and some infra logs the full request URL) — put
    // the key in the URL and it can leak into those logs. The header is not
    // logged by default infra and is Google's documented alternative to ?key=.
    const url = `${GEMINI_API_BASE_URL}/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const text = await withTimeout(
      new Promise((resolve, reject) => {
        const req = https.request(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-goog-api-key': GEMINI_API_KEY,
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
              const parts = json?.candidates?.[0]?.content?.parts || [];
              const combined = parts.map(p => p.text || '').join('').trim();
              if (!combined) {
                reject(new Error('Gemini API returned an empty response'));
                return;
              }
              resolve(combined);
            } catch (err) {
              reject(new Error(`Failed to parse Gemini API response: ${err.message}`));
            }
          });
        });
        req.once('error', reject);
        req.end(payload);
      }),
      GEMINI_RANGE_ADVISOR_TIMEOUT_MS,
      `Gemini API call timed out after ${GEMINI_RANGE_ADVISOR_TIMEOUT_MS}ms`
    );

    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new Error(`Gemini did not return valid JSON: ${cleaned.slice(0, 200)}`);
    }
    return parsed;
  }

  sanitizeSuggestion(symbol, currentPrice, raw) {
    const lower = Number(raw?.lower);
    const upper = Number(raw?.upper);
    const confidence = Number(raw?.confidence);
    if (!(lower > 0) || !(upper > 0) || !(lower < upper)) {
      throw new Error(`Gemini returned an invalid range: lower=${raw?.lower}, upper=${raw?.upper}`);
    }
    if (!(confidence >= 0 && confidence <= 1)) {
      throw new Error(`Gemini returned an invalid confidence: ${raw?.confidence}`);
    }
    // Safety clamp: the suggested range must contain the current price and
    // must not deviate further than GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT from it,
    // so a hallucinated or out-of-date suggestion can't blow up the grid.
    const maxLower = currentPrice * (1 - GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT / 100);
    const maxUpper = currentPrice * (1 + GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT / 100);
    const clampedLower = Math.max(lower, maxLower);
    const clampedUpper = Math.min(upper, maxUpper);
    if (!(clampedLower < currentPrice && clampedUpper > currentPrice)) {
      throw new Error(
        `Gemini suggested range ${lower}-${upper} does not bracket current price ${currentPrice} after clamping`
      );
    }
    const suggestion = {
      lower: roundNumber(clampedLower, 8),
      upper: roundNumber(clampedUpper, 8),
      confidence: roundNumber(confidence, 2),
      marketCondition: typeof raw?.marketCondition === 'string' ? raw.marketCondition : 'UNCERTAIN',
      reasoning: typeof raw?.reasoning === 'string' ? raw.reasoning.slice(0, 500) : '',
      wasClamped: clampedLower !== roundNumber(lower, 8) || clampedUpper !== roundNumber(upper, 8),
    };
    console.log(
      `[GEMINI] ${symbol} suggestion: range=${suggestion.lower}-${suggestion.upper} ` +
      `confidence=${suggestion.confidence} condition=${suggestion.marketCondition}` +
      `${suggestion.wasClamped ? ' (clamped to safety bounds)' : ''} — ${suggestion.reasoning}`
    );
    return suggestion;
  }
}

const AIGridValidator = GeminiRangeAdvisor;

module.exports = {
  TechnicalIndicators,
  GeminiRangeAdvisor,
  AIGridValidator
};
