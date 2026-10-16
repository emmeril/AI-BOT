const crypto = require('crypto');
const fs = require('fs');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class CrossProcessMutex {
  constructor(basePath, { timeoutMs = 30000, retryMs = 50, staleGraceMs = 2000 } = {}) {
    this.basePath = basePath;
    this.timeoutMs = timeoutMs;
    this.retryMs = retryMs;
    this.staleGraceMs = staleGraceMs;
  }

  pathFor(key) {
    const digest = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
    return `${this.basePath}.${digest}.lock`;
  }

  processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  async removeStaleLock(lockPath) {
    let raw;
    let stat;
    try {
      [raw, stat] = await Promise.all([
        fs.promises.readFile(lockPath, 'utf8'),
        fs.promises.stat(lockPath),
      ]);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }

    let owner;
    try {
      owner = JSON.parse(raw);
    } catch {
      owner = null;
    }

    const malformed = !owner || !Number.isInteger(owner.pid) || typeof owner.token !== 'string';
    if (!malformed && this.processIsAlive(owner.pid)) return false;
    if (malformed && Date.now() - stat.mtimeMs < this.staleGraceMs) return false;

    try {
      if (await fs.promises.readFile(lockPath, 'utf8') !== raw) return false;
      await fs.promises.unlink(lockPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }

  async acquire(key) {
    const lockPath = this.pathFor(key);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() <= deadline) {
      const token = crypto.randomUUID();
      let handle;
      try {
        handle = await fs.promises.open(lockPath, 'wx');
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        }));
        await handle.sync();
        await handle.close();
        return { lockPath, token };
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error.code !== 'EEXIST') throw error;
        if (await this.removeStaleLock(lockPath)) continue;
        await wait(this.retryMs);
      }
    }
    throw new Error(`Timed out waiting for mutual-entry lock: ${lockPath}`);
  }

  async release(lock) {
    try {
      const owner = JSON.parse(await fs.promises.readFile(lock.lockPath, 'utf8'));
      if (owner.token !== lock.token) return;
      await fs.promises.unlink(lock.lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async run(key, fn) {
    const lock = await this.acquire(key);
    try {
      return await fn();
    } finally {
      await this.release(lock);
    }
  }
}

module.exports = { CrossProcessMutex };
