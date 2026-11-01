'use strict';

const fs = require('fs');
const path = require('path');

function emptyState() {
  return { version: 1, updatedAt: new Date().toISOString(), symbols: {} };
}

function loadState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    parsed.symbols ||= {};
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error(`Cannot load scalper handoff state ${filePath}: ${error.message}`, { cause: error });
  }
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function isHandoffActive(filePath, symbol) {
  return loadState(filePath).symbols?.[symbol]?.handoffActive === true;
}

module.exports = {
  emptyState,
  isHandoffActive,
  loadState,
  saveState,
};
