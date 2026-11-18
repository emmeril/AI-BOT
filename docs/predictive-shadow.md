# Predictive Futures V2: shadow-only research

Predictive V2 estimates the probability that a **LONG** or **SHORT** price target is reached before a stop. The probabilities are independently modeled and do not need to sum to one. This is research software, not a promise of daily profits.

## Run it

1. Install the existing project dependencies: npm install
2. Retrieve public Binance USD-M 1m history, e.g. npm run fetch:predictive -- BTCUSDT 30
3. Train and evaluate three models: npm run train:predictive -- predictive-data/BTCUSDT-1m-30d.json predictive-results/BTCUSDT
4. Examine report-15m.json, report-30m.json, and report-60m.json. Positive results from one holdout do not authorize trading.
5. Run an isolated public-data-only observer:
   PREDICTIVE_SYMBOL=BTCUSDT PREDICTIVE_MODEL_DIR=predictive-results/BTCUSDT npm run start:predictive-shadow
6. The worker writes predictive-results/BTCUSDT-shadow-v2.json with each forecast, its outcome once the full horizon has elapsed, and no API keys or order requests.

Repeat for XRPUSDT and DOGEUSDT using separate data folders. The model is not trained on synthetic order book data.

## Trading assumptions for historical research

The default horizons are 15m, 30m, 60m, each separately trained with target 0.9%, stop 0.3%, and simulated taker fee 0.05% plus slippage 0.02% per side. These are experiment assumptions, not measured live exchange costs. The full net reward/risk is evaluated using these amounts before a LONG or SHORT decision. Probability selection is fitted on validation data, not on the holdout.

A signal closes at next candle OPEN with entry slippage. The simulator treats stop/target thresholds relative to the entry fill. A stop gap is filled at candle OPEN (possibly worse than stop); an intrabar candle that touches both levels hits the stop first; a remaining position exits at the configured time horizon. The label and the backtest share this exact simulator, preventing conflicting target/stop definitions.

Probability models use only completed candle history, taking both directions independently. Preprocessing uses training-window means and standard deviations. Training/validation/holdout use chronological 60/20/20 with purging equal to the label horizon.

## Forward evaluation

Each completed 1m candle creates up to three horizon-specific forecasts (LONG, SHORT, NO_TRADE). Forecasts are observed against real subsequent closed candles after 15, 30, or 60 minutes. The observer reports Brier scores, evaluated and pending counts, and **simulated**, not actual, PnL. If data gaps prevent evaluation, forecasts remain pending rather than inventing outcomes. Forecast state is written using an atomic file replacement, and completed prediction IDs prevent duplicate evaluations after restart.

## Limitations and safeguards

- No private Binance API keys, order creation, margin management or automatic live entry in V2.
- The old MA scalper, grid and Antigravity worker remain unchanged. The old V1 model modules remain in the repository for compatibility, but the predictive training and shadow CLI use V2.
- The module explicitly sets approvedForTrading:false.
- Holdout is one chronological split, not a rolling walk-forward series. Probability calibration and predictive regime segmentation are future tasks.
- The research simulation excludes funding, changing fee tiers, liquidations, network latency, exchange precision, variable order book spread, and account-level daily risk. PnL is percentage of traded notional, not wallet ROE.
- Only the latest ~1000 public candles are fetched during a shadow cycle. Predictions that can no longer be reconstructed from this window stay pending and must be reconciled with historical candles.
- Daily profit targets are neither guaranteed nor enforced in this research worker.

Run: npm run test:predictive. Full project regression: npm test. Verify live market results in shadow before proposing a separate testnet implementation.
