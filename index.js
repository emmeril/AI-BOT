const {
  Config,
  GRID_STATE_PATH,
  BOT_LOCK_PATH,
  validateRuntimeConfiguration
} = require('./src/config');
const { AtomicFileWriter } = require('./src/atomic-file-writer');
const { ProcessLock } = require('./src/process-lock');
const { GridState } = require('./src/grid-state');
const { GeminiRangeAdvisor, AIGridValidator, TechnicalIndicators } = require('./src/gemini-range-advisor');
const { SpotGridEngine } = require('./src/spot-grid-engine');

async function bootstrap() {
  validateRuntimeConfiguration();

  // Remove any *.tmp files left behind by a previous crashed process before
  // acquiring the lock so they don't interfere with new atomic writes.
  await AtomicFileWriter.cleanupStaleTempFiles(GRID_STATE_PATH);

  const lock = new ProcessLock(BOT_LOCK_PATH);
  lock.acquire();
  const shutdown = signal => {
    console.log(`[SHUTDOWN] ${signal}`);
    lock.release();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', () => lock.release());

  try {
    const engine = new SpotGridEngine();
    await engine.start();
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  bootstrap().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  Config,
  GridState,
  ProcessLock,
  SpotGridEngine,
  GeminiRangeAdvisor,
  AIGridValidator,
  TechnicalIndicators,
  bootstrap,
  validateRuntimeConfiguration,
};
