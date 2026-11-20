#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys

import numpy as np
import xgboost as xgb


def monotone_tp(predictions, groups):
    result = predictions[:, 2].astype(float).copy()
    starts = np.r_[0, np.flatnonzero(np.diff(groups)) + 1, len(groups)]
    for start, end in zip(starts[:-1], starts[1:]):
        result[start:end] = np.minimum.accumulate(result[start:end])
    return result


def isotonic(scores, labels):
    order = np.argsort(scores, kind='stable')
    x, first, counts = np.unique(scores[order], return_index=True, return_counts=True)
    sums = np.add.reduceat(labels[order].astype(float), first)
    blocks = []
    for i in range(len(x)):
        blocks.append([i, i, float(counts[i]), float(sums[i])])
        while len(blocks) > 1 and blocks[-2][3] / blocks[-2][2] > blocks[-1][3] / blocks[-1][2]:
            right = blocks.pop()
            left = blocks.pop()
            blocks.append([left[0], right[1], left[2] + right[2], left[3] + right[3]])
    knots_x, knots_y = [], []
    for start, end, count, total in blocks:
        for i in sorted(set([start, end])):
            knots_x.append(float(x[i]))
            knots_y.append(total / count)
    if len(knots_x) == 1:
        return dict(x=[0.0, 1.0], y=[knots_y[0], knots_y[0]])
    return dict(x=knots_x, y=knots_y)


def metrics(probabilities, labels):
    y = (labels == 2).astype(float)
    p = np.clip(probabilities, 1e-9, 1 - 1e-9)
    return dict(samples=len(y), brier=float(np.mean((p - y) ** 2)),
                logLoss=float(np.mean(-y * np.log(p) - (1 - y) * np.log(1 - p))),
                tpFrequency=float(np.mean(y)))


def trade_summary(mask, probabilities, data):
    groups = np.asarray(data['groups'])
    rewards = np.asarray(data['extras'])[:, -1]
    times = np.asarray(data['times'])
    exits = np.asarray(data['exitTimes'])
    net = np.asarray(data['netPcts'])
    chosen, sequential, counts = [], [], {'TP1': 0, 'TP2': 0}
    blocked_until = -1
    for group in np.unique(groups[mask]):
        candidates = np.flatnonzero(mask & (groups == group) & np.isin(rewards, [1, 2]) & (probabilities > 0.5))
        if not len(candidates):
            continue
        selected = candidates[np.argmax(rewards[candidates])]
        chosen.append(selected)
        if times[selected] >= blocked_until:
            sequential.append(selected)
            blocked_until = exits[selected]
            counts['TP' + str(int(rewards[selected]))] += 1

    def summary(indices):
        values = net[indices]
        return dict(trades=len(indices), wins=int(np.sum(values > 0)), losses=int(np.sum(values < 0)),
                    netWinRate=float(np.mean(values > 0)) if len(indices) else None,
                    summedNetUsdtAtFixed50=float(np.sum(values) * 0.5))

    return dict(overlapping=summary(chosen), onePositionAtATime=summary(sequential), selectedTargets=counts)


def main():
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
    output = pathlib.Path(sys.argv[2])
    original = json.loads(pathlib.Path(data['featureSource']).read_text())
    base = np.asarray(original['features'], dtype=np.float32)
    del original
    features = np.concatenate([base[np.asarray(data['featureIndices'])], np.asarray(data['extras'], dtype=np.float32)], axis=1)
    del base
    times = np.asarray(data['times'], dtype=np.int64)
    labels = np.asarray(data['labels'], dtype=np.int32)
    groups = np.asarray(data['groups'])
    horizon, boundaries = data['horizon'], data['boundaries']
    train = times + horizon * 60000 < boundaries['validationStart']
    calibration_mask = (times >= boundaries['validationStart']) & (times + horizon * 60000 < boundaries['auditStart'])
    audit = times >= boundaries['auditStart']
    if min(np.sum(train), np.sum(calibration_mask), np.sum(audit)) < 100:
        raise ValueError('Insufficient purged first-passage observations')
    booster = xgb.train(dict(objective='multi:softprob', num_class=3, tree_method='hist', nthread=2,
                             base_score=0.5, max_depth=3, eta=0.05, min_child_weight=50, reg_lambda=20,
                             subsample=0.85, colsample_bytree=0.9, max_bin=128, seed=73),
                        xgb.DMatrix(features[train], label=labels[train], nthread=2), num_boost_round=140)
    raw = booster.predict(xgb.DMatrix(features, nthread=2))
    raw_tp = monotone_tp(raw, groups)
    calibration = isotonic(raw_tp[calibration_mask], labels[calibration_mask] == 2)
    calibrated = np.interp(raw_tp, calibration['x'], calibration['y'])
    spec = importlib.util.spec_from_file_location('portable', pathlib.Path(__file__).with_name('research-predictive-direction.py'))
    portable = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(portable)
    classifier = portable.export_classifier(booster, features.shape[1])
    classifier['kind'] = 'boosted-first-passage-trees-v1'
    fixture = np.unique(np.linspace(0, len(features) - 1, 35, dtype=int))
    report = dict(objective='TP_BEFORE_SL_WITHIN_HORIZON', threshold=0.5,
                  uniqueForecasts=dict(train=int(len(np.unique(groups[train]))), calibration=int(len(np.unique(groups[calibration_mask]))),
                                       audit=int(len(np.unique(groups[audit])))),
                  calibration=metrics(calibrated[calibration_mask], labels[calibration_mask]),
                  audit=metrics(calibrated[audit], labels[audit]),
                  auditTrades=trade_summary(audit, calibrated, data),
                  calibrationFitOn='PURGED_CHRONOLOGICAL_CALIBRATION_ONLY',
                  skippedNonExecutableEntries=data['skippedNonExecutableEntries'],
                  limitations=['Upstream models were frozen before this training window',
                               'Historical periods were previously inspected; audit is not prospective live evidence',
                               'Targets and horizons overlap; raw sample counts are not independent trades',
                               'Replay excludes funding, liquidation, actual latency and session-loss pauses'])
    payload = dict(classifier=classifier, calibration=calibration, report=report,
                   parity=dict(features=features[fixture].tolist(), probabilities=raw[fixture].tolist()))
    (output / f'raw-model-{horizon}m.json').write_text(json.dumps(payload, allow_nan=False))
    print(json.dumps(dict(horizon=horizon, audit=report['audit'], auditTrades=report['auditTrades'])), flush=True)


if __name__ == '__main__':
    main()
