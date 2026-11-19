'use strict';

const { predict: predictSoftmax } = require('./model');

const checked = new WeakSet();

function validateBoostedClassifier(classifier) {
  if (checked.has(classifier)) return;
  const c = classifier;
  if (!['boosted-direction-trees-v1', 'boosted-quantile-trees-v1'].includes(c?.kind) || !Number.isInteger(c.featureCount) || c.featureCount < 1 ||
      !Array.isArray(c.baseMargins) || c.baseMargins.length !== 3 || !c.baseMargins.every(Number.isFinite) ||
      !Array.isArray(c.trees) || !c.trees.length || c.trees.length > 5000) {
    throw new Error('Invalid boosted direction classifier');
  }
  for (const tree of c.trees) {
    const n = tree.left?.length;
    if (!Number.isInteger(tree.classIndex) || tree.classIndex < 0 || tree.classIndex > 2 ||
        !Array.isArray(tree.left) || !n || n > 65535 ||
        ![tree.right, tree.feature, tree.values].every(a => Array.isArray(a) && a.length === n)) {
      throw new Error('Invalid direction tree');
    }
    for (let i = 0; i < n; i++) {
      const leaf = tree.left[i] === -1 && tree.right[i] === -1;
      if (!Number.isFinite(tree.values[i]) || (!leaf &&
          (![tree.left[i], tree.right[i]].every(child => Number.isInteger(child) && child > i && child < n) ||
           !Number.isInteger(tree.feature[i]) || tree.feature[i] < 0 || tree.feature[i] >= c.featureCount))) {
        throw new Error('Invalid direction tree node');
      }
    }
  }
  checked.add(c);
}

function predictTreeMargins(classifier, features) {
  validateBoostedClassifier(classifier);
  if (!Array.isArray(features) || features.length !== classifier.featureCount || !features.every(Number.isFinite)) {
    throw new Error('Invalid boosted direction features');
  }
  const values = features.map(Math.fround);
  const margins = [...classifier.baseMargins];
  for (const tree of classifier.trees) {
    let node = 0;
    while (tree.left[node] !== -1) {
      node = values[tree.feature[node]] < Math.fround(tree.values[node]) ? tree.left[node] : tree.right[node];
    }
    margins[tree.classIndex] = Math.fround(margins[tree.classIndex] + Math.fround(tree.values[node]));
  }
  return margins;
}

function predictBoosted(classifier, features) {
  if (classifier.kind !== 'boosted-direction-trees-v1') throw new Error('Expected a direction classifier');
  const margins = predictTreeMargins(classifier, features);
  const maximum = Math.max(...margins);
  const weights = margins.map(margin => Math.exp(margin - maximum));
  const sum = weights.reduce((a, b) => a + b, 0);
  return { down: weights[0] / sum, unchanged: weights[1] / sum, up: weights[2] / sum };
}

function validateEnsemble(classifier) {
  if (checked.has(classifier)) return;
  const c = classifier;
  if (c?.kind !== 'direction-ensemble-v1' || !Number.isInteger(c.featureCount) || c.featureCount < 1 ||
      !Array.isArray(c.members) || c.members.length !== 2 ||
      Math.abs(c.members.reduce((sum, m) => sum + m.weight, 0) - 1) > 1e-12) {
    throw new Error('Invalid direction ensemble');
  }
  for (const member of c.members) {
    if (!Number.isFinite(member.weight) || member.weight <= 0 ||
        !Number.isFinite(member.temperature) || member.temperature <= 0 ||
        !Array.isArray(member.featureIndices) || !member.featureIndices.every(i =>
          Number.isInteger(i) && i >= 0 && i < c.featureCount)) throw new Error('Invalid ensemble member');
    const inner = member.classifier;
    if (inner.kind === 'boosted-direction-trees-v1') {
      validateBoostedClassifier(inner);
      if (member.featureIndices.length !== inner.featureCount) throw new Error('Invalid member features');
    } else if (inner.kind === 'softmax-baseline-v1') {
      const dims = inner.mean?.length;
      if (!Array.isArray(inner.mean) || !dims || !inner.mean.every(Number.isFinite) ||
          !Array.isArray(inner.std) || inner.std.length !== dims ||
          !inner.std.every(value => Number.isFinite(value) && value > 0) ||
          !Array.isArray(inner.weights) || inner.weights.length !== 3 ||
          !inner.weights.every(w => Array.isArray(w) && w.length === dims + 1 && w.every(Number.isFinite)) ||
          member.featureIndices.length !== dims) throw new Error('Invalid linear ensemble member');
    } else throw new Error('Unsupported ensemble member');
  }
  checked.add(c);
}

function predictEnsemble(classifier, features) {
  validateEnsemble(classifier);
  if (!Array.isArray(features) || features.length !== classifier.featureCount || !features.every(Number.isFinite)) {
    throw new Error('Invalid direction ensemble features');
  }
  const result = { down: 0, unchanged: 0, up: 0 };
  for (const member of classifier.members) {
    const x = member.featureIndices.map(index => features[index]);
    let p;
    if (member.classifier.kind === 'boosted-direction-trees-v1') p = predictBoosted(member.classifier, x);
    else {
      const raw = predictSoftmax(member.classifier, x);
      p = { down: raw.DOWN, unchanged: raw.SIDEWAYS, up: raw.UP };
    }
    const logits = ['down', 'unchanged', 'up'].map(key => Math.log(Math.max(1e-15, p[key])) / member.temperature);
    const maximum = Math.max(...logits);
    const scaled = logits.map(value => Math.exp(value - maximum));
    const total = scaled.reduce((sum, value) => sum + value, 0);
    ['down', 'unchanged', 'up'].forEach((key, i) => { result[key] += member.weight * scaled[i] / total; });
  }
  return result;
}

function predictResearchClassifier(classifier, features) {
  if (classifier.kind === 'boosted-direction-trees-v1') return predictBoosted(classifier, features);
  const p = predictSoftmax(classifier, features);
  return { down: p.DOWN, unchanged: p.SIDEWAYS, up: p.UP };
}

module.exports = { validateBoostedClassifier, predictBoosted, validateEnsemble,
  predictEnsemble, predictResearchClassifier, predictTreeMargins };
