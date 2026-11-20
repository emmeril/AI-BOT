'use strict';

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ACTIONS = new Set(['LONG', 'SHORT', 'HOLD']);
const RISKS = new Set(['LOW', 'MEDIUM', 'HIGH']);
const REASON_CODES = new Set([
  'TREND', 'MOMENTUM', 'FLOW', 'VOLATILITY', 'REVERSAL', 'CONFLICT', 'INSUFFICIENT_DATA',
]);

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          action: { type: 'string', enum: [...ACTIONS] },
          confidence: { type: 'integer', minimum: 0, maximum: 100 },
          horizonMinutes: { type: 'string', enum: ['60', '240'] },
          risk: { type: 'string', enum: [...RISKS] },
          reasonCodes: {
            type: 'array',
            items: { type: 'string', enum: [...REASON_CODES] },
            maxItems: 3,
          },
          reason: { type: 'string', maxLength: 160 },
        },
        required: ['symbol', 'action', 'confidence', 'horizonMinutes', 'risk', 'reasonCodes', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
});

function buildPrompt(snapshots, options = {}) {
  const operatingContext = options.liveEnabled
    ? 'Your output may authorize an automated LONG or SHORT entry when it passes the configured confidence and freshness checks.'
    : 'Your output is being recorded for observation only and will not control trading.';
  if (options.purpose === 'PREDICTIVE_ENTRY_REVIEW') {
    return `Review the supplied DOGEUSDT predictive entry candidates for Binance USD-M perpetual markets.
${operatingContext}
You cannot place or manage orders. Do not use tools, files, web access, memory, or outside facts.
Analyze only the supplied completed 1-minute candles and the causal 5, 15, 60 and 240 minute window summaries.
The existing statistical model already selected the direction, stop and net-risk TP1/TP2 candidates.
Your role is to approve that candidate direction or choose HOLD. Never reverse a candidate, invent targets, widen its stop, change sizing, or bypass its cost and risk checks.
For each supplied symbol return exactly one decision using the required JSON schema:
- LONG only to approve a LONG candidate with supporting trend, momentum, taker flow and acceptable volatility.
- SHORT only to approve a SHORT candidate with supporting trend, momentum, taker flow and acceptable volatility.
- HOLD when the supplied candidate is unsupported, its expected net is nonpositive, evidence conflicts, volatility is dangerous, or data is insufficient.
- horizonMinutes must be "60". candidate.expiresAt ends the forecast window; it is not an automatic position deadline under PREDICTION_REVERSAL.
- Follow candidate.positionExitPolicy: PREDICTION_REVERSAL keeps a protected position open while fresh statistical forecasts align and closes on a validated reversal; HORIZON closes at the forecast deadline. TP/SL and safety exits remain active under both policies.
- Confidence is a subjective assessment, not a measured probability of profit. Do not claim guaranteed profit or invent future prices.
- The execution worker independently rechecks costs and price, and may adjust TP1/TP2 using its frozen net-risk policy at the actual quote and fill.

Return only JSON matching this schema, without Markdown or explanations:
${JSON.stringify(OUTPUT_SCHEMA)}

Input candidates:
${JSON.stringify(snapshots)}`;
  }
  return `You are producing directional forecasts for Binance USD-M perpetual markets.
${operatingContext}
You cannot place or manage orders. Analyze only the supplied numeric data from completed 15-minute candles. Do not use tools, files, web access, memory, or outside facts.

For every supplied symbol return exactly one decision:
- LONG only when the next 1 to 4 hours have a clear upward edge.
- SHORT only when the next 1 to 4 hours have a clear downward edge.
- HOLD when evidence conflicts, volatility is dangerous, data is insufficient, or confidence is below 65.
- Account for an estimated 0.14% round-trip fee and slippage hurdle before choosing LONG or SHORT.
- Confidence is calibration, not certainty. Do not claim guaranteed profit.

Input snapshots:
${JSON.stringify(snapshots)}`;
}

function parseJsonText(value, label) {
  const text = String(value || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const newlineValues = text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(value => value && typeof value === 'object');
    if (newlineValues.length > 0) return newlineValues.at(-1);
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseEnvelope(stdout) {
  const envelope = parseJsonText(stdout, 'Antigravity output');
  if (envelope.status !== 'SUCCESS') {
    throw new Error(`Antigravity returned ${envelope.status || 'unknown status'}: ${envelope.error || 'no response'}`);
  }
  return {
    payload: envelope.structured_output && typeof envelope.structured_output === 'object'
      ? envelope.structured_output
      : parseJsonText(envelope.response, 'Antigravity response'),
    metadata: {
      conversationId: envelope.conversation_id || null,
      durationSeconds: Number(envelope.duration_seconds) || null,
      usage: envelope.usage || null,
    },
  };
}

function normalizeDecisions(raw, symbols, minimumConfidence = 65) {
  if (!Array.isArray(raw?.decisions)) throw new Error('Antigravity response is missing decisions');
  const expected = new Set(symbols);
  const seen = new Set();
  const normalized = raw.decisions.map(item => {
    const symbol = String(item?.symbol || '').trim();
    const requestedAction = String(item?.action || '').trim().toUpperCase();
    const confidence = Number(item?.confidence);
    const horizonMinutes = Number(item?.horizonMinutes);
    const risk = String(item?.risk || '').trim().toUpperCase();
    if (!expected.has(symbol)) throw new Error(`Antigravity returned unexpected symbol ${symbol || '(empty)'}`);
    if (seen.has(symbol)) throw new Error(`Antigravity returned duplicate symbol ${symbol}`);
    if (!ACTIONS.has(requestedAction)) throw new Error(`Antigravity returned invalid action for ${symbol}`);
    if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
      throw new Error(`Antigravity returned invalid confidence for ${symbol}`);
    }
    if (![60, 240].includes(horizonMinutes)) {
      throw new Error(`Antigravity returned invalid horizon for ${symbol}`);
    }
    if (!RISKS.has(risk)) throw new Error(`Antigravity returned invalid risk for ${symbol}`);
    const reasonCodes = Array.isArray(item.reasonCodes)
      ? item.reasonCodes.filter(code => REASON_CODES.has(code)).slice(0, 3)
      : [];
    seen.add(symbol);
    return {
      symbol,
      action: confidence >= minimumConfidence ? requestedAction : 'HOLD',
      requestedAction,
      confidence,
      horizonMinutes,
      risk,
      reasonCodes,
      reason: String(item.reason || '').trim().slice(0, 160),
    };
  });
  if (seen.size !== expected.size || [...expected].some(symbol => !seen.has(symbol))) {
    throw new Error('Antigravity response does not contain exactly one decision per symbol');
  }
  return normalized;
}

async function requestAntigravity(snapshots, options = {}) {
  const binary = options.binary || path.join(os.homedir(), '.local', 'bin', 'agy');
  const timeoutMs = Math.max(10_000, Number(options.timeoutMs) || 120_000);
  const effort = options.effort ?? String(options.model || '').match(/-(low|medium|high)$/)?.[1] ?? 'low';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Invalid Antigravity effort');
  const childEnvironment = { ...process.env, ...(options.environment || {}) };
  delete childEnvironment.GEMINI_API_KEY;
  delete childEnvironment.GOOGLE_API_KEY;
  delete childEnvironment.GOOGLE_APPLICATION_CREDENTIALS;
  for (const key of Object.keys(childEnvironment)) {
    if (/^(EXCHANGE_|BINANCE_)/.test(key)) delete childEnvironment[key];
  }
  const args = [
    '-p', buildPrompt(snapshots, { liveEnabled: Boolean(options.liveEnabled), purpose: options.purpose }),
    '--output-format', 'json',
    ...(options.purpose === 'PREDICTIVE_ENTRY_REVIEW' ? [] : [
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA), '--mode', 'plan',
    ]),
    '--sandbox',
    '--disable-slash-commands',
    '--effort', effort,
    '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`,
  ];
  if (options.model) args.push('--model', options.model);
  const runner = options.execFile || execFileAsync;
  let result;
  try {
    result = await runner(binary, args, {
      cwd: os.tmpdir(),
      env: childEnvironment,
      timeout: options.strictDeadline ? timeoutMs : timeoutMs + 5000,
      ...(options.signal ? { signal: options.signal } : {}),
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error?.stdout) parseEnvelope(error.stdout);
    const diagnostic = String(error?.stderr || error?.message || error)
      .split('\n')
      .find(line => line.trim())
      ?.trim();
    throw new Error(`Antigravity execution failed: ${diagnostic || 'unknown error'}`);
  }
  const parsed = parseEnvelope(result.stdout);
  return {
    decisions: normalizeDecisions(
      parsed.payload,
      snapshots.map(snapshot => snapshot.symbol),
      Number(options.minimumConfidence ?? 65)
    ),
    metadata: parsed.metadata,
  };
}

module.exports = {
  OUTPUT_SCHEMA,
  buildPrompt,
  normalizeDecisions,
  parseEnvelope,
  requestAntigravity,
};
