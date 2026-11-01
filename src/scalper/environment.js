'use strict';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readBoolean(environment, name, fallback = false) {
  return booleanValue(environment[name], fallback);
}

function readNumber(environment, name, fallback) {
  return numberValue(environment[name], fallback);
}

module.exports = {
  booleanValue,
  numberValue,
  readBoolean,
  readNumber,
};
