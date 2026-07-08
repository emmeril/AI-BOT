const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    if (timeoutId.unref) timeoutId.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function retry(fn, retries = 3, delay = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(delay * attempt);
    }
  }
}

function roundNumber(value, digits = 8) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOrZero(value) {
  return Number(value) || 0;
}

function scopedTradeId(symbol, id) {
  return `${symbol}|${id}`;
}

module.exports = {
  sleep,
  sleepSync,
  withTimeout,
  retry,
  roundNumber,
  isPlainObject,
  numberOrZero,
  scopedTradeId
};
