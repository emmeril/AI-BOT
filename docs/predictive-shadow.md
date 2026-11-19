# Predictive Futures V2: price direction

The active V2 training and shadow worker estimate whether the future candle close will be higher, lower, or exactly equal to the latest completed candle close. Direction forecasts are independent of TP, SL, fees, entry thresholds and simulated trading profits. A separate excursion model estimates TP/SL levels after the direction forecast. Position entry remains a downstream task.

## Train and run DOGE

```bash
npm run fetch:predictive -- DOGEUSDT 60
npm run train:predictive -- predictive-data/DOGEUSDT-1m-60d.json predictive-results/DOGEUSDT-direction-v2
PREDICTIVE_SYMBOL=DOGEUSDT PREDICTIVE_MODEL_DIR=predictive-results/DOGEUSDT-direction-v2 npm run start:predictive-shadow
```

Training creates `model-15m.json`, `model-30m.json`, `model-60m.json`, matching reports, and a manifest identifying the symbol, source data and training run. Use a new output directory for subsequent training runs. The worker rejects mixed training runs, wrong symbols, and models with the old TP/SL objective.

The default state file is `predictive-results/DOGEUSDT-direction-shadow-v2.json`. Override it with `PREDICTIVE_SHADOW_STATE_FILE`. Direction forecasts use a separate state file from the previous TP/SL observer; old model artifacts and forecasts remain available for historical research.

## Prediction definition

For a forecast made at completed candle close `t`, the label compares `close(t + horizon)` with `close(t)`, for horizons of 15, 30 and 60 minutes:

- `UP`: the future close is higher.
- `DOWN`: the future close is lower.
- `UNCHANGED`: both closing prices are exactly equal. There is no TP/SL band or minimum movement threshold.

Output includes `probabilities.up`, `probabilities.down` and `probabilities.unchanged`, which sum to one; the most likely `direction`; its probability as `confidence`; the `referencePrice`; and the `targetCloseTime`. An exact tie for the largest probability has direction `UNCERTAIN`. These are model estimates, not measured future success rates or instructions to place orders.

The worker publishes every valid direction forecast, including forecasts with weak validation results or probabilities near 50%. Fresh forecasts have status `FORECAST`. Stale or invalid market data has status `UNAVAILABLE`, without invented probabilities. The old `NO_TRADE` status and TP/SL probability names are absent from direction forecasts.

## Historical evaluation

The classifier is a linear softmax baseline using nine features from completed candles. Its three numerical classes represent DOWN, exactly UNCHANGED and UP. The older softmax implementation is reused as a numerical classifier; its internal `SIDEWAYS` slot represents exactly equal closing prices in the direction model.

Training, validation and holdout are chronological 60/20/20 splits. A full forecast horizon is purged before each boundary to prevent future labels from overlapping the next split. Feature normalization uses training data only. Temperature scaling is selected from a fixed set using validation log loss; the selected model is then evaluated on holdout without adjusting parameters from holdout results.

Each report provides accuracy, balanced accuracy, multiclass Brier score, log loss, confidence, class counts and a confusion matrix. It compares the model with constant class probabilities estimated from training data. This baseline's most likely class is determined from training, not from future holdout frequencies. No trading PnL, target/stop outcomes or minimum transaction count is used to approve or suppress a prediction.

Accuracy is separate from trading profitability. A single chronological split is not a rolling walk-forward study, and consecutive predictions overlap and are correlated. Calibration on validation does not guarantee calibration on future market data. Historical scores must be reported alongside the baseline, including weak or negative skill.

## Forward evaluation

The worker polls public Binance USD-M 1m candles once per minute and publishes forecasts for all three horizons. Once the target candle has closed, it records the actual price direction and return, whether the forecast's most likely direction was correct, Brier score and log loss. Metrics are aggregated by horizon. It does not submit trades or report predicted trading profits.

Each forecast identifies its model and training run. State writes use atomic replacement, and existing IDs prevent duplicate forecasts and outcomes on restart. Only the latest approximately 1000 candles are fetched in a cycle. Predictions that cannot be reconstructed after an extended interruption remain pending and require historical data reconciliation.

Models are frozen while the worker runs. Collect new data and run training explicitly before switching the worker to a completed model directory. Training, validation and monitoring do not grant live trading approval: models retain `approvedForTrading:false`, and forecasts retain `tradeExecutionEnabled:false`.

## Tests and legacy research

Run `npm run test:predictive` for direction tests and the retained TP/SL research tests. Run `npm test` for the full repository suite.

The old hit-first labels, simulator, evaluator, parameter profiles and forward evaluator remain in `src/predictive/` for historical research and compatibility. The active `train:predictive` and `start:predictive-shadow` commands use the price direction modules. The MA scalper, grid and existing trading workers are independent of this observer.

## Accuracy research

The separate research command compares three shallow tree configurations and a regularized linear classifier using 37 causal features. Context features cover up to 240 completed minutes: returns, moving average gaps, RSI, volatility, price position, candle shape, volume and taker flow. Training and the live 1000-candle window compute identical features. The first nine features preserve the deployed baseline inputs.

```bash
python3 -m venv .venv-predictive
.venv-predictive/bin/python -m pip install -r requirements-predictive.txt
npm run research:predictive -- predictive-data/DOGEUSDT-1m-60d.json predictive-results/DOGEUSDT-direction-v2 predictive-results/DOGEUSDT-direction-research-next
```

Use the frozen original linear baseline directory and a new output directory. The Python trainer uses the pinned CPU distribution of XGBoost ([official installation guide](https://xgboost.readthedocs.io/en/stable/install.html)) and exports numeric trees from its JSON model ([official model IO documentation](https://xgboost.readthedocs.io/en/stable/tutorials/saving_model.html)). Runtime inference remains in Node.js; the worker does not need Python. Exported models must reproduce Python probabilities within 0.000001, including float32 split equality, before evaluation continues.

Architecture selection uses three expanding temporal folds within the earliest 60% of the data. Every fold purges a full label horizon at its boundary. Fits use training-only preprocessing and a fixed 30-day half-life for sample weights. The next 20% selects a fixed blend weight from 0%, 25%, 50% and 100% and a calibration temperature. A candidate must improve validation accuracy by at least 0.2 percentage point, with log loss deterioration at most 0.002; otherwise that horizon keeps its baseline classifier. Models and selections are written before the final audit is evaluated.

The final audit compares every forecast with the frozen baseline on exactly the same timestamps. There is no confidence-based sample filtering. Reports include paired UTC-day block bootstrap intervals so overlapping minute forecasts are not treated as independent observations. This historical audit overlaps a previously inspected holdout: its results are exploratory, and new forward observations are needed to establish future improvement. The first research run also checked the context linear candidate after inspecting the initial audit; its temporal-fold accuracy was weaker and it was not selected. This supplemental check is labeled separately in the reports.

`comparison.json` and the manifest record whether the candidate passes the historical promotion checks. The loader rejects research bundles with `promotionEligible:false`. Candidate classifiers, reports and Python parity fixtures remain available even when the bundle is rejected; the active PM2 model directory is not changed by the research command.

On the first 60-day DOGE experiment, the selected bundle changed combined audit accuracy from 50.95% to 50.83%. The 15-minute accuracy remained 52.08%; 30-minute accuracy changed from 50.83% to 50.47%; the 60-minute classifier was retained at 49.94%. Probability log loss improved on the first two horizons, but the bundle failed the accuracy promotion checks. The original model remains active. These figures use the common audit timestamps and can differ slightly from the original training reports' split boundaries.

## TP/SL estimates after price direction

Train the separate exit models against the existing frozen direction models:

```bash
npm run train:predictive-exits -- predictive-data/DOGEUSDT-1m-60d.json predictive-results/DOGEUSDT-direction-v2 predictive-results/DOGEUSDT-exit-levels-v1
```

The trainer uses the same Python environment and pinned dependencies as accuracy research. Use a new exit output directory for each run. The worker reads `PREDICTIVE_EXIT_MODEL_DIR`, defaulting to `predictive-results/DOGEUSDT-exit-levels-v1`. Exit artifacts bind to direction model IDs and record SHA-256 hashes of their source files. Training verifies that those files did not change; it does not retrain the direction models.

For each historical forecast time, labels measure the highest high and lowest low in the next 15, 30 or 60 completed candles relative to the signal close. Both excursions are nonnegative, include every historical window, and exclude the signal candle's extremes. They are scaled by recent 60-minute return volatility and the square root of the horizon. A 0.01% numerical scale floor handles flat history; it does not set TP/SL distances.

For each upward and downward excursion, quantile regression estimates the 25th, 50th and 75th percentiles using the 37 context features. A volatility-normalized empirical estimate is also fitted. Training and validation boundaries match the frozen direction model, with a full-horizon purge. Validation calibrates offsets and selects the estimator with lower pinball loss. Holdout then reports actual quantile coverage. Crossed estimates are sorted and negative excursion estimates are clipped to zero. See the [XGBoost quantile regression example](https://xgboost.readthedocs.io/en/release_2.1.0/python/examples/quantile_regression.html) for the underlying objective.

Each fresh forecast receives an `exitPlan` after its direction and probabilities are computed:

- `UP` produces a LONG plan: TP uses the median upward excursion, SL uses the 75th percentile downward excursion.
- `DOWN` produces a SHORT plan: TP uses the median downward excursion, SL uses the 75th percentile upward excursion.
- `UNCHANGED` or `UNCERTAIN` has no directional exit plan.

`entryReference` is the signal candle close, not an actual fill. Plans include `takeProfit`, `stopLoss`, percentage distances, reward/risk, quantile estimates and expiry at the forecast horizon. The worker fetches Binance's public price tick at startup. Targets round toward the entry reference and stops away from it. If public metadata is unavailable, prices remain indicative and explicitly unrounded. An estimate smaller than a price tick does not produce an invented larger target.

These quantiles describe excursion distributions. A 50th percentile TP is not a 50% probability of TP occurring before SL; a 75th percentile adverse excursion is not a guaranteed stop coverage rate in future markets. Direction probabilities and forecasts are never suppressed by exit reward/risk or costs.

Plans show cost coverage using assumed taker fees of 0.05% and slippage of 0.02% per side. The initial holdout simulation had negative mean results after these assumptions, approximately -0.14% per forecast. This is a measured research limitation, not a profitable trading strategy. Plans remain `indicative:true` and `executionAllowed:false`.

Forward evaluation preserves the frozen plan and records `exitOutcome` after the horizon closes. The simulation enters at the next candle open with entry slippage, skips entry gaps outside the original protection levels, fills later stop gaps at the candle open, and treats simultaneous intrabar TP/SL touches as SL first. It includes exit slippage and fees. Counts and mean simulated percentage per forecast appear under `exitPlans`; overlapping forecasts are not aggregated as a portfolio return. Historical reports use unrounded reference levels; live shadow plans use the fetched tick.

Existing direction-only state remains readable. Only newly created forecasts receive exit plans; plans are not reconstructed retroactively for earlier forecasts. If exit models are missing or incompatible, direction forecasts continue with an explicit unavailable exit estimate.
