# Architecture

## Runtime topology

Production starts through `scripts/start-futures-dual.js`. The supervisor owns three workers:

1. The LONG legacy worker manages only positions and exits left by the former grid strategy.
2. The SHORT legacy worker manages only positions and exits left by the former grid strategy.
3. The scalper worker owns new LONG and SHORT entries after a pair completes handoff.

If one worker stops unexpectedly, the supervisor stops the other workers. PM2 then restarts the complete group. This prevents two partially healthy strategies from sharing the same account without their companion risk services.

## Scalper modules

New scalper code lives under `src/scalper/`. Each module has one responsibility:

| Module | Responsibility |
|---|---|
| `allocation.js` | Read wallet balance and calculate equal per-pair notional allocation. |
| `config.js` | Parse scalper settings and build side-specific strategy configuration. |
| `state-store.js` | Load and atomically save scalper runtime state. |
| `position-policy.js` | Decide handoff readiness, identify open positions, and calculate TP/SL prices. |
| `order-inspection.js` | Normalize Binance conditional orders and verify side-specific TP/SL coverage. |
| `telegram-notifier.js` | Format and send one Telegram notification. |
| `telegram-reports.js` | Build operator status and order reports from exchange data. |
| `dashboard-view.js` | Convert scalper state and Binance orders into the dashboard contract. |
| `environment.js` | Parse shared boolean and numeric values without process-level side effects. |

`src/futures-scalper-engine.js` is the application service. It coordinates exchange calls and the modules above, but policy and presentation rules stay outside the engine.

## Compatibility boundaries

`src/scalper-handoff.js` and `src/scalper-telegram.js` are compatibility facades. Existing integrations may keep importing them, while new code imports the focused modules under `src/scalper/` directly.

`futures-grid.js` remains responsible for legacy grid exits and shared Telegram command polling. Scalper-specific report construction is delegated to `ScalperTelegramReports`; no new scalper policy should be added to the legacy file.

## Dependency direction

Dependencies flow in one direction:

```text
launchers
  -> application services
    -> scalper policy and adapters
      -> exchange and filesystem APIs
```

Policy modules must not import `futures-grid.js`, dashboard server code, or process launchers. Presentation modules may consume policy results, but they must not place or cancel exchange orders.

## Trading invariants

Changes must preserve these rules:

- LONG and SHORT positions are identified by Hedge Mode `positionSide`.
- Entry allocation is divided equally across configured pairs.
- A new position receives both a side-specific take profit and stop loss.
- Failure to install protection triggers a market safety close.
- Pausing blocks new entries but does not stop position monitoring or protection repair.
- Handoff starts only when legacy positions, regular orders, and conditional orders are all empty.
- Dashboard and Telegram status are read-only views of exchange and state data.

## Change workflow

Run the focused suite while changing scalper modules:

```bash
npm run test:scalper
```

Before production deployment, run the complete suite:

```bash
npm test
```

Restart `futures-bot` only after both suites pass. After restart, verify PM2 status, Binance positions, regular orders, conditional TP/SL orders, dashboard authentication, and Telegram connectivity.
