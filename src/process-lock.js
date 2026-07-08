const fs = require('fs');
const crypto = require('crypto');
const { BOT_LOCK_STALE_GRACE_MS } = require('./config');
const { sleepSync } = require('./utils');

class ProcessLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.fd = null;
    this.ownerToken = null;
  }

  processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  readOwner() {
    const raw = fs.readFileSync(this.lockPath, 'utf8').trim();
    if (!raw) {
      return { pid: null, token: null, malformed: true };
    }
    try {
      const parsed = JSON.parse(raw);
      const pid = Number(parsed.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        return { pid: null, token: null, malformed: true };
      }
      return {
        pid,
        token: typeof parsed.token === 'string' ? parsed.token : null,
      };
    } catch {
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) {
        return { pid, token: null };
      }
      return { pid: null, token: null, malformed: true };
    }
  }

  removeMalformedLock(owner) {
    if (!owner?.malformed) return false;
    if (owner.pid && this.processIsAlive(owner.pid)) return false;
    try {
      fs.unlinkSync(this.lockPath);
      console.warn(`[LOCK] Removed malformed stale lock ${this.lockPath}`);
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return true;
    }
  }

  removeStaleLock(owner) {
    if (!owner || owner.malformed || this.processIsAlive(owner.pid)) return false;
    console.warn(`[LOCK] Found stale lock for PID ${owner.pid}; waiting ${BOT_LOCK_STALE_GRACE_MS}ms before failing closed`);
    sleepSync(BOT_LOCK_STALE_GRACE_MS);

    let latest;
    try {
      latest = this.readOwner();
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }

    const sameOwner = latest.pid === owner.pid && latest.token === owner.token;
    if (!sameOwner || this.processIsAlive(latest.pid)) return false;
    throw new Error(`Stale bot lock found for PID ${owner.pid}. Remove ${this.lockPath} manually after confirming no bot is running.`);
  }

  ownsLock() {
    if (!this.ownerToken) return false;
    try {
      const owner = this.readOwner();
      return owner.pid === process.pid && owner.token === this.ownerToken;
    } catch {
      return false;
    }
  }

  assertLockCanBeAcquired() {
    try {
      const owner = this.readOwner();
      if (this.removeMalformedLock(owner)) return true;
      if (this.removeStaleLock(owner)) return true;
      if (!this.processIsAlive(owner.pid)) return false;
      return false;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }
  }

  acquire() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        this.fd = fs.openSync(this.lockPath, 'wx');
        this.ownerToken = crypto.randomUUID();
        fs.writeSync(this.fd, JSON.stringify({
          pid: process.pid,
          token: this.ownerToken,
          acquiredAt: new Date().toISOString(),
        }));
        fs.fsyncSync(this.fd);
        if (!this.ownsLock()) {
          fs.closeSync(this.fd);
          this.fd = null;
          this.ownerToken = null;
          throw new Error(`Lost bot lock during acquisition: ${this.lockPath}`);
        }
        console.log(`[LOCK] Acquired lock ${this.lockPath} for PID ${process.pid}`);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let owner;
        try {
          owner = this.readOwner();
        } catch (readErr) {
          if (readErr.code === 'ENOENT') continue;
          throw readErr;
        }
        if (this.removeMalformedLock(owner)) continue;
        if (this.processIsAlive(owner.pid)) {
          throw new Error(`Bot already running with PID ${owner.pid}. Lock: ${this.lockPath}`);
        }
        if (this.removeStaleLock(owner)) continue;
      }
    }
    throw new Error(`Unable to acquire bot lock after repeated stale-lock cleanup: ${this.lockPath}`);
  }

  release() {
    if (this.fd === null) return;
    // Capture and clear the token BEFORE closing fd so ownsLock() can't be
    // called after the file descriptor is invalid.  We verify ownership using
    // the in-memory token directly rather than re-reading the lock file after
    // closeSync(), which would introduce a TOCTOU race.
    const tokenSnapshot = this.ownerToken;
    try {
      // Check ownership while fd is still open (file content is stable).
      const isOwner = tokenSnapshot !== null && this.ownsLock();
      fs.closeSync(this.fd);
      if (isOwner) {
        try {
          fs.unlinkSync(this.lockPath);
          console.log(`[LOCK] Released lock ${this.lockPath}`);
        } catch (err) {
          if (err.code !== 'ENOENT') console.warn('[LOCK] Failed to unlink lock file:', err.message);
        }
      } else {
        console.warn('[LOCK] Not releasing a lock with a different ownership token');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[LOCK] Failed to release:', err.message);
    } finally {
      this.fd = null;
      this.ownerToken = null;
    }
  }
}

module.exports = { ProcessLock };
