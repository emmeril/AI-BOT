# Futures predictive shadow baseline

This is a **research-only** addition to AI-BOT. It does not place orders, access private trading keys, or modify the existing MA scalper, grid, Antigravity OAuth signal worker, or dashboard. It does not guarantee daily profits.

## Workflow

1. Install existing dependencies with `npm install`.
2. Fetch public, contiguous 1-minute USD-M futures candles: `node scripts/fetch-predictive-klines.js BTCUSDT 30`. Repeat for XRPUSDT and DOGEUSDT if needed. This requires Binance network access.
3. Train and evaluate: `node scripts/train-predictive.js predictive-data/BTCUSDT-1m-30d.json predictive-results/BTCUSDT`.
4. Read `predictive-results/BTCUSDT/report.json` and record the holdout metrics and assumptions. Results on artificially generated candles must never be advertised as real performance.
5. Observe live market inference with `PREDICTIVE_MODEL_PATH=predictive-results/BTCUSDT/model.json PREDICTIVE_SYMBOL=BTCUSDT node scripts/start-predictive-shadow.js`. Data is public and signals are appended to `predictive-results/shadow.jsonl`. **No orders are submitted.**
6. Run tests: `node --test tests/predictive-shadow.test.js`.

## Statistical design and safety

- Node.js softmax logistic regression baseline, no GPU or Python required, classes DOWN/SIDEWAYS/UP and trailing price, flow and volatility features.
- Only complete contiguous Binance candles are accepted. No fabricated order book or open-interest history.
- Future candles are used for labels only. Normalization is fitted on the **training period only**.
- Three chronological periods: training (60%), validation (20%), untouched holdout (20%). A one-horizon gap prevents overlapping future labels across splits. Confidence is selected on validation, never on holdout.
- Simulated entries use the next 1m open, stop-first for OHLC ambiguity, and estimated maker/taker trading fees and slippage. The default fee/slippage assumptions are illustrative; inspect actual account fees before interpreting results.
- Reporting uses notional-relative percentage PnL. It is **not** wallet return and does not implement isolated margin, liquidation, funding, network latency, order book dynamics or complete portfolio-level risk.
- Every generated model has `approved:false` and the shadow worker requires that explicit value. There is no LIVE mode or way to place an order in this module.
- An exploratory positive holdout is not sufficient to approve live trading.

## Future work before any live strategy

Collect real depth snapshot and delta stream, open interest and funding histories; perform full walk-forward backtests and calibration of estimated probabilities; implement side-specific triple barriers, time-of-day/market-regime filters, WIB daily profit/loss gates, transaction-level reconciliation, stop/position risk sizing, execution mutual exclusion, shadow outcome scoring, and testnet verification.

A daily +1% target should be treated only as a possible stop-entry threshold, never a requirement or guarantee. Loss days and no-trade days are expected.
