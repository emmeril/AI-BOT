function evaluateEmaTrendEntry(analysis, positionSide, options = {}) {
  const timeframe = String(options.timeframe || '5m');
  const timeframeAnalysis = analysis?.timeframes?.[timeframe];
  const ema20 = Number(timeframeAnalysis?.ema20);
  const ema50 = Number(timeframeAnalysis?.ema50);
  const side = String(positionSide || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !(ema20 > 0) || !(ema50 > 0)) {
    return {
      allow: options.failClosed !== true,
      available: false,
      side,
      timeframe,
      reason: 'ema_trend_unavailable',
    };
  }
  const trend = ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL';
  const requiredTrend = side === 'SHORT' ? 'BEARISH' : 'BULLISH';
  return {
    allow: trend === requiredTrend,
    available: true,
    side,
    timeframe,
    ema20,
    ema50,
    trend,
    requiredTrend,
    reason: trend === requiredTrend ? 'trend_aligned' : 'trend_opposed',
  };
}

module.exports = { evaluateEmaTrendEntry };
