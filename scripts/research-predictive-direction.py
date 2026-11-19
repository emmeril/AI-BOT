#!/usr/bin/env python3
import json
import pathlib
import sys

import numpy as np
import xgboost as xgb


class LinearClassifier:
    def __init__(self, x, y, weights):
        self.mean = x.astype(float).mean(axis=0)
        self.std = np.maximum(1e-8, x.astype(float).std(axis=0))
        data = np.column_stack([np.ones(len(x)), np.clip((x - self.mean) / self.std, -8, 8)])
        self.weights = np.zeros((data.shape[1], 3))
        counts = np.bincount(y, minlength=3) + 1
        self.weights[0] = np.log(counts / counts.sum())
        target = np.eye(3)[y]
        for _ in range(250):
            logits = data @ self.weights
            p = np.exp(logits - logits.max(axis=1, keepdims=True))
            p /= p.sum(axis=1, keepdims=True)
            gradient = data.T @ ((p - target) * weights[:, None]) / weights.sum()
            gradient[1:] += 0.02 * self.weights[1:]
            self.weights -= 0.08 * gradient

    def predict(self, x):
        data = np.column_stack([np.ones(len(x)), np.clip((x - self.mean) / self.std, -8, 8)])
        logits = data @ self.weights
        p = np.exp(logits - logits.max(axis=1, keepdims=True))
        return p / p.sum(axis=1, keepdims=True)


def predict(booster, x):
    if isinstance(booster, LinearClassifier):
        return booster.predict(x)
    return booster.predict(xgb.DMatrix(x, nthread=2))


def metrics(probabilities, labels):
    p = np.clip(probabilities.astype(float), 1e-15, 1)
    truth = np.eye(3)[labels]
    return dict(samples=len(labels), accuracy=float(np.mean(np.argmax(p, axis=1) == labels)),
                logLoss=float(-np.log(p[np.arange(len(labels)), labels]).mean()),
                brier=float(np.square(p - truth).sum(axis=1).mean()))


def fit(x, y, times, cutoff, horizon, spec):
    indices = np.where(times + horizon * 60000 < cutoff)[0]
    age_days = (cutoff - times[indices]) / 86400000
    weights = np.power(0.5, age_days / 30).astype(np.float32)
    if spec.get('kind') == 'linear':
        return LinearClassifier(x[indices], y[indices], weights)
    data = xgb.DMatrix(x[indices], label=y[indices], weight=weights, nthread=2)
    params = dict(objective='multi:softprob', num_class=3, tree_method='hist', nthread=2,
                  seed=17, base_score=0.5, eta=0.04, max_bin=128,
                  subsample=0.85, colsample_bytree=0.9, reg_lambda=20,
                  min_child_weight=spec['minChildWeight'], max_depth=spec['depth'])
    return xgb.train(params, data, num_boost_round=spec['rounds'])


def export_classifier(booster, dimensions):
    if isinstance(booster, LinearClassifier):
        return dict(kind='softmax-baseline-v1', mean=booster.mean.tolist(),
                    std=booster.std.tolist(), weights=booster.weights.T.tolist())
    raw = json.loads(booster.save_raw(raw_format='json'))
    saved = raw['learner']['gradient_booster']['model']
    trees = []
    for tree, group in zip(saved['trees'], saved['tree_info']):
        if any(tree['split_type']):
            raise ValueError('Categorical splits are unsupported')
        trees.append(dict(classIndex=group, left=tree['left_children'], right=tree['right_children'],
                          feature=tree['split_indices'], values=tree['split_conditions']))
    return dict(kind='boosted-direction-trees-v1', featureCount=dimensions,
                baseMargins=[0.5, 0.5, 0.5], trees=trees, libraryVersion=xgb.__version__)


def main():
    source = json.loads(pathlib.Path(sys.argv[1]).read_text())
    output = pathlib.Path(sys.argv[2])
    output.mkdir(parents=True, exist_ok=True)
    x = np.asarray(source['features'], dtype=np.float32)
    times = np.asarray(source['times'], dtype=np.int64)
    specs = [dict(name='shallow', depth=2, rounds=120, minChildWeight=100),
             dict(name='medium', depth=3, rounds=160, minChildWeight=80),
             dict(name='context', depth=4, rounds=160, minChildWeight=100)]
    linear_only = '--linear-only' in sys.argv[3:]
    if linear_only:
        specs = []
    specs.append(dict(name='context-linear', kind='linear'))
    boundaries = source['boundaries']
    all_results = {}
    for horizon_text, target in source['labels'].items():
        horizon = int(horizon_text)
        y = np.asarray(target, dtype=np.int32)
        valid = y >= 0
        current_x, current_times, current_y = x[valid], times[valid], y[valid]
        previous = None
        if linear_only:
            previous = json.loads((output / f'classifier-{horizon}m.json').read_text())
        candidates = previous['selection']['candidates'] if previous else []
        for spec in specs:
            folds = []
            for start, end in boundaries['selectionFolds']:
                booster = fit(current_x, current_y, current_times, start, horizon, spec)
                mask = (current_times >= start) & (current_times + horizon * 60000 < end)
                probabilities = predict(booster, current_x[mask])
                folds.append(metrics(probabilities, current_y[mask]))
            candidates.append(dict(parameters=spec, folds=folds,
                                   meanAccuracy=float(np.mean([f['accuracy'] for f in folds])),
                                   meanLogLoss=float(np.mean([f['logLoss'] for f in folds]))))
            print(json.dumps(dict(horizon=horizon, candidate=spec['name'],
                                  meanAccuracy=candidates[-1]['meanAccuracy'])), flush=True)
        chosen = sorted(candidates, key=lambda c: (-c['meanAccuracy'], c['meanLogLoss']))[0]
        if previous and chosen['parameters']['name'] != 'context-linear':
            previous['selection']['candidates'] = candidates
            (output / f'classifier-{horizon}m.json').write_text(json.dumps(previous, allow_nan=False))
            all_results[horizon] = previous['selection']
            continue
        booster = fit(current_x, current_y, current_times, boundaries['validationStart'], horizon, chosen['parameters'])
        classifier = export_classifier(booster, x.shape[1])
        parity_indices = np.unique(np.linspace(0, len(current_x) - 1, 40, dtype=int))
        parity_x = current_x[parity_indices]
        parity_p = predict(booster, parity_x)
        result = dict(classifier=classifier, selection=dict(selectedOn='PURGED_TEMPORAL_FOLDS',
                      candidates=candidates, selectedParameters=chosen['parameters']),
                      parity=dict(features=parity_x.tolist(), probabilities=parity_p.tolist()))
        (output / f'classifier-{horizon}m.json').write_text(json.dumps(result, allow_nan=False))
        all_results[horizon] = result['selection']
    (output / 'selection.json').write_text(json.dumps(all_results, indent=2))


if __name__ == '__main__':
    main()
