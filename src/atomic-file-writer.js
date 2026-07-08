const fs = require('fs');
const path = require('path');

class AtomicFileWriter {
  static queues = new Map();
  static counter = 0;

  static write(filePath, buildContents) {
    const previous = AtomicFileWriter.queues.get(filePath) || Promise.resolve();
    const sequence = ++AtomicFileWriter.counter;
    const current = previous
      .catch(() => {})
      .then(async () => {
        const tempPath = `${filePath}.${process.pid}.${sequence}.tmp`;
        try {
          await fs.promises.writeFile(tempPath, buildContents());
          await fs.promises.rename(tempPath, filePath);
        } catch (err) {
          // Best-effort cleanup of the orphaned temp file so it doesn't accumulate.
          fs.promises.unlink(tempPath).catch(() => {});
          throw err;
        }
      })
      .finally(() => {
        if (AtomicFileWriter.queues.get(filePath) === current) {
          AtomicFileWriter.queues.delete(filePath);
        }
      });
    AtomicFileWriter.queues.set(filePath, current);
    return current;
  }

  /**
   * Remove any leftover *.tmp files for the given base path that were
   * abandoned by a previous (crashed) process.  Safe to call on startup
   * before any writes begin.
   */
  static async cleanupStaleTempFiles(filePath) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    const stalePattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.\\d+\\.tmp$`);
    for (const entry of entries) {
      if (!stalePattern.test(entry)) continue;
      const tmpPath = path.join(dir, entry);
      try {
        await fs.promises.unlink(tmpPath);
        console.warn(`[FILE] Removed stale temp file: ${tmpPath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn(`[FILE] Could not remove stale temp file ${tmpPath}:`, err.message);
        }
      }
    }
  }
}

module.exports = { AtomicFileWriter };
