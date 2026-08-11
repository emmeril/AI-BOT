const fs = require('fs');
const ccxt = require('ccxt');
const { AtomicFileWriter } = require('./atomic-file-writer');
const { retry, roundNumber } = require('./utils');

const DEFAULT_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618];

function timeframeToMs(timeframe) {
  if (typeof ccxt?.Exchange?.parseTimeframe === 'function') {
    try {
      const seconds = ccxt.Exchange.parseTimeframe(timeframe);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    } catch {
      // Fall through to the ccxt-compatible parser below.
    }
  }
  const match = /^(\d+)([smhdwM])$/.exec(String(timeframe || '').trim());
  if (!match) return 0;
  const unitMs = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    M: 30 * 24 * 60 * 60 * 1000,
  }[match[2]];
  return Number(match[1]) * unitMs;
}

function ratioWeight(ratio) {
  const closeTo = target => Math.abs(ratio - target) < 1e-9;
  if (closeTo(0.618) || closeTo(1.618)) return 3;
  if (closeTo(2.618)) return 2.25;
  if (closeTo(0.382) || closeTo(0.786) || closeTo(1.272)) return 1.75;
  if (closeTo(0) || closeTo(1)) return 1.5;
  return 1;
}

class FibonacciRangeAdvisor {
  constructor(exchange, options = {}) {
    this.exchange = exchange;
    this.options = {
      enabled: false,
      timeframes: ['all'],
      ratios: DEFAULT_RATIOS,
      candleCloseBufferMs: 5000,
      clusterTolerancePct: 0.15,
      minClusterScore: 1,
      minRangeWidthPct: 6,
      maxDistancePct: 25,
      rebuildThresholdPct: 0.5,
      rebuildCooldownMs: 15 * 60 * 1000,
      levelCount: 11,
      minimumStepRatio: 1.0025025,
      statePath: '',
      ...options,
    };
    this.options.ratios = [...new Set(this.options.ratios.map(Number))]
      .filter(ratio => Number.isFinite(ratio) && ratio >= 0)
      .sort((a, b) => a - b);
    this.cache = this.loadCache();
    this.warnedUnsupportedTimeframes = new Set();
  }

  isEnabled() {
    return Boolean(this.options.enabled);
  }

  loadCache() {
    if (!this.options.statePath) return {};
    try {
      if (fs.existsSync(this.options.statePath)) {
        return JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) || {};
      }
    } catch (err) {
      console.warn('[FIBONACCI] Failed to read advisor cache, starting fresh:', err.message);
    }
    return {};
  }

  async saveCache() {
    if (!this.options.statePath) return;
    await AtomicFileWriter.write(this.options.statePath, () => JSON.stringify(this.cache, null, 2));
  }

  resolveTimeframes() {
    const requested = this.options.timeframes.map(value => String(value).trim()).filter(Boolean);
    const available = Object.keys(this.exchange?.timeframes || {});
    const useAll = requested.some(value => value.toLowerCase() === 'all');
    const selected = useAll && available.length ? available : requested;
    const supported = selected.filter(timeframe => {
      const parsed = timeframeToMs(timeframe) > 0;
      const exchangeSupportsIt = !available.length || available.includes(timeframe);
      if (parsed && exchangeSupportsIt) return true;
      if (!this.warnedUnsupportedTimeframes.has(timeframe)) {
        console.warn(`[FIBONACCI] Ignoring unsupported timeframe: ${timeframe}`);
        this.warnedUnsupportedTimeframes.add(timeframe);
      }
      return false;
    });
    return [...new Set(supported)].sort((a, b) => timeframeToMs(a) - timeframeToMs(b));
  }

  getLastClosedCandleStart(now, timeframeMs) {
    const bufferedNow = now - this.options.candleCloseBufferMs;
    return Math.floor(bufferedNow / timeframeMs) * timeframeMs - timeframeMs;
  }

  async fetchLastClosedCandle(symbol, timeframe, now = Date.now()) {
    const timeframeMs = timeframeToMs(timeframe);
    if (!(timeframeMs > 0)) return null;
    const candles = await retry(() => this.exchange.fetchOHLCV(symbol, timeframe, undefined, 4));
    if (!Array.isArray(candles)) return null;
    const closedBefore = now - this.options.candleCloseBufferMs;
    for (let i = candles.length - 1; i >= 0; i--) {
      const candle = candles[i];
      const timestamp = Number(candle?.[0]);
      const open = Number(candle?.[1]);
      const high = Number(candle?.[2]);
      const low = Number(candle?.[3]);
      const close = Number(candle?.[4]);
      if (!(timestamp >= 0) || timestamp + timeframeMs > closedBefore) continue;
      if (!(high > low) || !(low > 0) || ![open, high, low, close].every(Number.isFinite)) continue;
      return { timeframe, timeframeMs, timestamp, open, high, low, close };
    }
    return null;
  }

  async getSuggestion(symbol, currentPrice, now = Date.now()) {
    if (!this.isEnabled() || !(currentPrice > 0)) return null;
    const timeframes = this.resolveTimeframes();
    if (!timeframes.length) return this.cache[symbol]?.suggestion || null;

    const entry = this.cache[symbol] || { candles: {}, suggestion: null, lastAppliedAt: 0 };
    const configFingerprint = this.getConfigFingerprint(timeframes);
    const configChanged = entry.configFingerprint !== configFingerprint;
    if (configChanged) {
      entry.candles = Object.fromEntries(
        Object.entries(entry.candles || {}).filter(([timeframe]) => timeframes.includes(timeframe))
      );
      entry.suggestion = null;
      entry.lastAppliedAt = 0;
      entry.configFingerprint = configFingerprint;
    }
    let refreshed = configChanged;
    for (const timeframe of timeframes) {
      const timeframeMs = timeframeToMs(timeframe);
      const targetStart = this.getLastClosedCandleStart(now, timeframeMs);
      const cachedTimestamp = Number(entry.candles?.[timeframe]?.timestamp ?? -1);
      if (cachedTimestamp >= targetStart) continue;
      try {
        const candle = await this.fetchLastClosedCandle(symbol, timeframe, now);
        if (!candle || candle.timestamp <= cachedTimestamp) continue;
        entry.candles[timeframe] = candle;
        refreshed = true;
      } catch (err) {
        console.warn(`[FIBONACCI] ${symbol} ${timeframe} candle refresh failed:`, err.message);
      }
    }

    const currentInsideCachedRange = entry.suggestion &&
      currentPrice > Number(entry.suggestion.lower) &&
      currentPrice < Number(entry.suggestion.upper);
    if (!refreshed && currentInsideCachedRange) return entry.suggestion;

    const freshSuggestion = this.buildSuggestion(
      symbol,
      currentPrice,
      Object.values(entry.candles || {})
    );
    if (freshSuggestion && this.shouldAdoptSuggestion(entry.suggestion, freshSuggestion, currentPrice, entry.lastAppliedAt, now)) {
      entry.suggestion = freshSuggestion;
      entry.lastAppliedAt = now;
      console.log(
        `[FIBONACCI] ${symbol} applied ${freshSuggestion.timeframeCount}-timeframe confluence range ` +
        `${roundNumber(freshSuggestion.lower, 8)}-${roundNumber(freshSuggestion.upper, 8)} ` +
        `(score=${roundNumber(freshSuggestion.confluenceScore, 2)})`
      );
    }
    entry.lastComputedAt = now;
    this.cache[symbol] = entry;
    await this.saveCache();
    return entry.suggestion && (currentInsideCachedRange || freshSuggestion)
      ? entry.suggestion
      : null;
  }

  getConfigFingerprint(timeframes) {
    return JSON.stringify({
      timeframes,
      ratios: this.options.ratios,
      clusterTolerancePct: this.options.clusterTolerancePct,
      minClusterScore: this.options.minClusterScore,
      minRangeWidthPct: this.options.minRangeWidthPct,
      maxDistancePct: this.options.maxDistancePct,
      levelCount: this.options.levelCount,
      minimumStepRatio: this.options.minimumStepRatio,
    });
  }

  shouldAdoptSuggestion(previous, next, currentPrice, lastAppliedAt = 0, now = Date.now()) {
    if (!previous) return true;
    if (currentPrice <= previous.lower || currentPrice >= previous.upper) return true;
    if (now - Number(lastAppliedAt || 0) < this.options.rebuildCooldownMs) return false;
    const previousLevels = Array.isArray(previous.levels) ? previous.levels : [previous.lower, previous.upper];
    const nextLevels = Array.isArray(next.levels) ? next.levels : [next.lower, next.upper];
    if (previousLevels.length !== nextLevels.length) return true;
    const levelShiftPcts = [];
    for (let i = 0; i < previousLevels.length; i++) {
      const oldPrice = Number(previousLevels[i]);
      const newPrice = Number(nextLevels[i]);
      if (!(oldPrice > 0) || !(newPrice > 0)) return true;
      levelShiftPcts.push(Math.abs(newPrice - oldPrice) / oldPrice * 100);
    }

    // A single noisy Fibonacci level must not churn the entire live grid.
    // The median requires at least half of the grid to move materially.
    levelShiftPcts.sort((a, b) => a - b);
    const representativeShiftPct = levelShiftPcts[Math.floor(levelShiftPcts.length / 2)];
    return representativeShiftPct >= this.options.rebuildThresholdPct;
  }

  buildSuggestion(symbol, currentPrice, candles) {
    const validCandles = candles.filter(candle =>
      candle && candle.high > candle.low && candle.low > 0 && timeframeToMs(candle.timeframe) > 0
    );
    if (!validCandles.length) return null;
    const candidates = this.buildCandidates(validCandles);
    const clusters = this.normalizeClustersForExchange(
      symbol,
      this.clusterCandidates(candidates, currentPrice)
    )
      .filter(cluster => cluster.score >= this.options.minClusterScore)
      .filter(cluster => {
        const distancePct = Math.abs(cluster.price - currentPrice) / currentPrice * 100;
        return distancePct <= this.options.maxDistancePct;
      });
    const selection = this.selectGridLevels(clusters, currentPrice);
    if (!selection) return null;

    const timeframeCount = new Set(selection.clusters.flatMap(cluster => cluster.timeframes)).size;
    const averageConfluence = selection.clusters.reduce((sum, cluster) => sum + cluster.confluence, 0) /
      selection.clusters.length;
    const confidence = Math.min(0.99, roundNumber(0.45 + Math.log2(1 + averageConfluence) * 0.12, 4));
    return {
      source: 'FIBONACCI',
      lower: selection.levels[0],
      upper: selection.levels[selection.levels.length - 1],
      levels: selection.levels,
      confidence,
      confluenceScore: roundNumber(selection.score, 4),
      timeframeCount,
      marketCondition: 'FIBONACCI_CONFLUENCE',
      reasoning: `${timeframeCount} closed-candle timeframes produced ${selection.levels.length} fee-spaced Fibonacci confluence levels for ${symbol}.`,
      generatedAt: new Date().toISOString(),
    };
  }

  buildCandidates(candles) {
    const minimumTimeframeMs = Math.min(...candles.map(candle => timeframeToMs(candle.timeframe)));
    const candidates = [];
    for (const candle of candles) {
      const range = candle.high - candle.low;
      const timeframeMs = timeframeToMs(candle.timeframe);
      const timeframeWeight = 1 + Math.log2(Math.max(timeframeMs / minimumTimeframeMs, 1));
      for (const ratio of this.options.ratios) {
        const score = timeframeWeight * ratioWeight(ratio);
        if (ratio <= 1) {
          candidates.push({
            price: candle.low + range * ratio,
            ratio,
            timeframe: candle.timeframe,
            score,
          });
          continue;
        }
        candidates.push({
          price: candle.low + range * ratio,
          ratio,
          timeframe: candle.timeframe,
          score,
        });
        const lowerExtension = candle.high - range * ratio;
        if (lowerExtension > 0) {
          candidates.push({
            price: lowerExtension,
            ratio: -ratio,
            timeframe: candle.timeframe,
            score,
          });
        }
      }
    }
    return candidates.filter(candidate => candidate.price > 0 && Number.isFinite(candidate.price));
  }

  clusterCandidates(candidates, currentPrice) {
    const sorted = [...candidates].sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const candidate of sorted) {
      const last = clusters[clusters.length - 1];
      const differencePct = last
        ? Math.abs(candidate.price - last.price) / currentPrice * 100
        : Infinity;
      if (!last || differencePct > this.options.clusterTolerancePct) {
        clusters.push({
          price: candidate.price,
          rawScore: candidate.score,
          score: candidate.score,
          candidates: [candidate],
          timeframes: [candidate.timeframe],
          ratios: [candidate.ratio],
          confluence: 1,
        });
        continue;
      }
      const combinedScore = last.rawScore + candidate.score;
      last.price = (last.price * last.rawScore + candidate.price * candidate.score) / combinedScore;
      last.rawScore = combinedScore;
      last.candidates.push(candidate);
      last.timeframes = [...new Set(last.candidates.map(item => item.timeframe))];
      last.ratios = [...new Set(last.candidates.map(item => item.ratio))];
      last.confluence = last.timeframes.length;
      last.score = last.rawScore * (1 + (last.confluence - 1) * 0.15);
    }
    return clusters;
  }

  normalizeClustersForExchange(symbol, clusters) {
    if (typeof this.exchange?.priceToPrecision !== 'function') return clusters;
    const byPrice = new Map();
    for (const cluster of clusters) {
      let precisePrice;
      try {
        precisePrice = Number(this.exchange.priceToPrecision(symbol, cluster.price));
      } catch {
        continue;
      }
      if (!(precisePrice > 0) || !Number.isFinite(precisePrice)) continue;
      const key = String(precisePrice);
      const existing = byPrice.get(key);
      if (!existing) {
        byPrice.set(key, { ...cluster, price: precisePrice });
        continue;
      }
      existing.rawScore += cluster.rawScore;
      existing.candidates.push(...cluster.candidates);
      existing.timeframes = [...new Set([...existing.timeframes, ...cluster.timeframes])];
      existing.ratios = [...new Set([...existing.ratios, ...cluster.ratios])];
      existing.confluence = existing.timeframes.length;
      existing.score = existing.rawScore * (1 + (existing.confluence - 1) * 0.15);
    }
    return [...byPrice.values()].sort((a, b) => a.price - b.price);
  }

  selectGridLevels(clusters, currentPrice) {
    const levelCount = Math.max(3, Number(this.options.levelCount) || 3);
    const minimumRatio = Math.max(Number(this.options.minimumStepRatio) || 1, 1);
    const minimumWidth = currentPrice * this.options.minRangeWidthPct / 100;
    const supports = this.getBoundaryCandidates(
      clusters.filter(cluster => cluster.price <= currentPrice / minimumRatio)
    );
    const resistances = this.getBoundaryCandidates(
      clusters.filter(cluster => cluster.price >= currentPrice * minimumRatio)
    );
    let best = null;

    for (const lower of supports) {
      for (const upper of resistances) {
        if (upper.price - lower.price < minimumWidth) continue;
        if (upper.price / lower.price < Math.pow(minimumRatio, levelCount - 1)) continue;
        const selected = this.selectLevelsWithinBounds(
          clusters,
          lower,
          upper,
          levelCount,
          minimumRatio,
          currentPrice
        );
        if (!selected) continue;
        const midpoint = (lower.price + upper.price) / 2;
        const asymmetryPenalty = Math.abs(midpoint - currentPrice) / currentPrice * 10;
        const widthPenalty = (upper.price - lower.price) / currentPrice * 0.05;
        const score = selected.reduce((sum, cluster) => sum + cluster.score, 0) -
          asymmetryPenalty - widthPenalty;
        if (!best || score > best.score) best = { clusters: selected, score };
      }
    }

    if (!best) return null;
    return {
      clusters: best.clusters,
      levels: best.clusters.map(cluster => roundNumber(cluster.price, 12)),
      score: best.score,
    };
  }

  getBoundaryCandidates(clusters) {
    if (clusters.length <= 40) return clusters;
    const strongest = [...clusters].sort((a, b) => b.score - a.score).slice(0, 34);
    const byPrice = [...clusters].sort((a, b) => a.price - b.price);
    const edgeCandidates = [...byPrice.slice(0, 3), ...byPrice.slice(-3)];
    return [...new Set([...strongest, ...edgeCandidates])];
  }

  selectLevelsWithinBounds(clusters, lower, upper, levelCount, minimumRatio, currentPrice) {
    const supportCount = Math.floor(levelCount / 2);
    const resistanceCount = levelCount - supportCount;
    const supportCeiling = currentPrice / minimumRatio;
    const resistanceFloor = currentPrice * minimumRatio;
    const supports = clusters.filter(cluster =>
      cluster.price >= lower.price && cluster.price <= supportCeiling
    );
    const resistances = clusters.filter(cluster =>
      cluster.price >= resistanceFloor && cluster.price <= upper.price
    );
    const selectedSupports = this.selectAscendingSide(
      supports,
      lower,
      supportCeiling,
      supportCount,
      minimumRatio
    );
    const selectedResistances = this.selectDescendingSide(
      resistances,
      upper,
      resistanceFloor,
      resistanceCount,
      minimumRatio
    );
    if (!selectedSupports || !selectedResistances) return null;
    if (selectedResistances[0].price / selectedSupports[selectedSupports.length - 1].price < minimumRatio) {
      return null;
    }
    return [...selectedSupports, ...selectedResistances];
  }

  selectAscendingSide(candidates, lower, ceiling, count, minimumRatio) {
    if (count < 1) return [];
    const pool = [
      lower,
      ...candidates
        .filter(candidate => candidate !== lower && candidate.price > lower.price && candidate.price <= ceiling)
        .sort((a, b) => a.price - b.price),
    ];
    const memo = new Map();
    const search = (previousIndex, position) => {
      if (position === count) return { utility: 0, path: [] };
      const key = `${previousIndex}:${position}`;
      if (memo.has(key)) return memo.get(key);
      const previous = pool[previousIndex];
      const remainingPoints = count - 1 - position;
      const target = lower.price * Math.pow(ceiling / lower.price, position / Math.max(count - 1, 1));
      let best = null;
      for (let index = previousIndex + 1; index < pool.length; index++) {
        const candidate = pool[index];
        if (candidate.price / previous.price < minimumRatio) continue;
        if (candidate.price * Math.pow(minimumRatio, remainingPoints) > ceiling) continue;
        const tail = search(index, position + 1);
        if (!tail) continue;
        const distancePct = Math.abs(candidate.price - target) / target * 100;
        const utility = candidate.score / (1 + distancePct) + tail.utility;
        if (!best || utility > best.utility) {
          best = { utility, path: [candidate, ...tail.path] };
        }
      }
      memo.set(key, best);
      return best;
    };
    const result = search(0, 1);
    return result ? [lower, ...result.path] : null;
  }

  selectDescendingSide(candidates, upper, floor, count, minimumRatio) {
    if (count < 1) return [];
    const pool = [
      upper,
      ...candidates
        .filter(candidate => candidate !== upper && candidate.price < upper.price && candidate.price >= floor)
        .sort((a, b) => b.price - a.price),
    ];
    const memo = new Map();
    const search = (previousIndex, position) => {
      if (position === count) return { utility: 0, path: [] };
      const key = `${previousIndex}:${position}`;
      if (memo.has(key)) return memo.get(key);
      const previous = pool[previousIndex];
      const remainingPoints = count - 1 - position;
      const target = upper.price / Math.pow(upper.price / floor, position / Math.max(count - 1, 1));
      let best = null;
      for (let index = previousIndex + 1; index < pool.length; index++) {
        const candidate = pool[index];
        if (previous.price / candidate.price < minimumRatio) continue;
        if (candidate.price / Math.pow(minimumRatio, remainingPoints) < floor) continue;
        const tail = search(index, position + 1);
        if (!tail) continue;
        const distancePct = Math.abs(candidate.price - target) / target * 100;
        const utility = candidate.score / (1 + distancePct) + tail.utility;
        if (!best || utility > best.utility) {
          best = { utility, path: [candidate, ...tail.path] };
        }
      }
      memo.set(key, best);
      return best;
    };
    const result = search(0, 1);
    return result ? [upper, ...result.path].reverse() : null;
  }
}

module.exports = {
  FibonacciRangeAdvisor,
  timeframeToMs,
  ratioWeight,
};
