#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys

import numpy as np
import xgboost as xgb


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summaries(mask, expected, calibrated, data):
    times = np.asarray(data['times'])
    rewards = np.asarray(data['extras'])[:, -1]
    stop_ids = np.asarray(data['stopIds'])
    exits = np.asarray(data['exitTimes'])
    net = np.asarray(data['netPcts'])
    loss = np.asarray(data['estimatedLossPcts'])

    def summarize(indices):
        values = net[indices]
        return dict(trades=len(indices), wins=int(np.sum(values > 0)), losses=int(np.sum(values < 0)),
                    netWinRate=float(np.mean(values > 0)) if len(values) else None,
                    summedNetUsdtAtFixed50=float(np.sum(values) * 0.5))

    result = {}
    for strategy in ['ADAPTIVE_EXPECTED_NET', 'ADAPTIVE_PROBABILITY_50', 'MEDIAN_EXPECTED_NET', 'MEDIAN_PROBABILITY_50',
                     'MEDIAN_TP1_ALL', 'MEDIAN_TP2_ALL']:
        eligible = mask & np.isin(rewards, [1, 2])
        if strategy.startswith('MEDIAN'):
            eligible &= stop_ids == 'Q50'
        if strategy.endswith('EXPECTED_NET'):
            eligible &= expected > 1e-12
        elif strategy.endswith('PROBABILITY_50'):
            eligible &= calibrated > 0.5
        else:
            eligible &= rewards == (1 if strategy == 'MEDIAN_TP1_ALL' else 2)
        selected, sequential = [], []
        blocked_until = -1
        counts = dict(TP1=0, TP2=0)
        stops = {}
        indices = np.flatnonzero(eligible)
        candidate_groups = np.split(indices, np.flatnonzero(np.diff(times[indices])) + 1) if len(indices) else []
        for candidates in candidate_groups:
            time = times[candidates[0]]
            pick = sorted(candidates, key=lambda i: (-rewards[i], -expected[i], loss[i], stop_ids[i]))[0]
            selected.append(pick)
            if time >= blocked_until:
                sequential.append(pick)
                blocked_until = exits[pick]
                counts['TP' + str(int(rewards[pick]))] += 1
                stops[stop_ids[pick]] = stops.get(stop_ids[pick], 0) + 1
        result[strategy] = dict(overlapping=summarize(selected), onePositionAtATime=summarize(sequential),
                                selectedTargets=counts, selectedStops=stops)
    return result


def main():
    data = json.loads(pathlib.Path(sys.argv[1]).read_text())
    output = pathlib.Path(sys.argv[2])
    source = json.loads(pathlib.Path(data['featureSource']).read_text())
    base = np.asarray(source['features'], dtype=np.float32)
    del source
    features = np.concatenate([base[np.asarray(data['featureIndices'])], np.asarray(data['extras'], dtype=np.float32)], axis=1)
    del base
    times = np.asarray(data['times'], dtype=np.int64)
    labels = np.asarray(data['labels'], dtype=np.int32)
    groups = np.asarray(data['groups'])
    horizon, boundaries = data['horizon'], data['boundaries']
    train = times + horizon * 60000 < boundaries['validationStart']
    calibration_mask = (times >= boundaries['validationStart']) & (times + horizon * 60000 < boundaries['auditStart'])
    audit = times >= boundaries['auditStart']
    if min(np.sum(train), np.sum(calibration_mask), np.sum(audit), np.sum(train & (labels == 1))) < 100:
        raise ValueError('Insufficient purged adaptive-exit observations')
    booster = xgb.train(dict(objective='multi:softprob', num_class=3, tree_method='hist', nthread=2,
                             base_score=0.5, max_depth=3, eta=0.05, min_child_weight=50, reg_lambda=20,
                             subsample=0.85, colsample_bytree=0.9, max_bin=128, seed=73),
                        xgb.DMatrix(features[train], label=labels[train], nthread=2), num_boost_round=140)
    raw = booster.predict(xgb.DMatrix(features, nthread=2))
    legacy = load_module('passage', 'train-predictive-reachability.py')
    raw_tp = legacy.monotone_tp(raw, groups)
    calibration = legacy.isotonic(raw_tp[calibration_mask], labels[calibration_mask] == 2)
    calibrated = np.interp(raw_tp, calibration['x'], calibration['y'])
    odds = np.log(np.maximum(1e-15, raw[:, 0]).astype(float) / np.maximum(1e-15, raw[:, 1]))
    non_tp = calibration_mask & (labels != 2)

    def non_tp_loss(temperature):
        p = np.clip(1 / (1 + np.exp(-odds[non_tp] / temperature)), 1e-9, 1 - 1e-9)
        y = (labels[non_tp] == 0).astype(float)
        return float(np.mean(-y * np.log(p) - (1 - y) * np.log(1 - p)))

    temperature = min([0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0], key=non_tp_loss)
    stop_probability = (1 - calibrated) / (1 + np.exp(-odds / temperature))
    timeout_probability = 1 - calibrated - stop_probability
    net = np.asarray(data['netPcts'])
    scale = np.asarray(data['scales'])
    loss = np.asarray(data['estimatedLossPcts'])
    profit = np.asarray(data['estimatedProfitPcts'])
    fit = train & (labels == 1)
    mean = features[fit].astype(float).mean(axis=0)
    std = features[fit].astype(float).std(axis=0)
    std[std < 1e-8] = 1.0
    standardized = (features.astype(float) - mean) / std
    design = np.column_stack([np.ones(np.sum(fit)), standardized[fit]])
    penalty = np.eye(design.shape[1]) * 100.0
    penalty[0, 0] = 0
    weights = np.linalg.solve(design.T @ design + penalty, design.T @ (net[fit] / scale[fit]))
    timeout_scaled = weights[0] + standardized @ weights[1:]
    timeout = np.clip(timeout_scaled * scale, -loss, profit)
    gap = np.maximum(0, -net[train & (labels == 0)] - loss[train & (labels == 0)]) / scale[train & (labels == 0)]
    gap_penalty = float(np.quantile(gap, 0.95)) if len(gap) else 0.0
    expected = calibrated * profit - stop_probability * (loss + gap_penalty * scale) + timeout_probability * timeout
    portable = load_module('portable', 'research-predictive-direction.py')
    classifier = portable.export_classifier(booster, features.shape[1])
    classifier['kind'] = 'boosted-first-passage-trees-v1'
    fixture = np.unique(np.linspace(0, len(features) - 1, 35, dtype=int))
    report = dict(objective='EXPECTED_NET_AFTER_COSTS', threshold=0,
                  uniqueForecasts=dict(train=int(len(np.unique(times[train]))), calibration=int(len(np.unique(times[calibration_mask]))),
                                       audit=int(len(np.unique(times[audit])))),
                  calibration=legacy.metrics(calibrated[calibration_mask], labels[calibration_mask]),
                  audit=legacy.metrics(calibrated[audit], labels[audit]),
                  timeoutAuditMaePct=float(np.mean(np.abs(timeout[audit & (labels == 1)] - net[audit & (labels == 1)]))),
                  expectedNetAuditMaePct=float(np.mean(np.abs(expected[audit] - net[audit]))),
                  calibrationFitOn='PURGED_CHRONOLOGICAL_CALIBRATION_ONLY',
                  timeoutFitOn='PURGED_TRAIN_TIMEOUTS_ONLY',
                  auditTrades=summaries(audit, expected, calibrated, data),
                  skippedNonExecutableEntries=data['skippedNonExecutableEntries'],
                  limitations=['Audit period was inspected previously; this is not prospective trading evidence',
                               'One-position replay excludes funding, liquidation, actual latency and session-loss pauses',
                               'Minute candles use stop-first treatment when TP and SL are both touched',
                               'Positive predicted expectancy is not an observed profitable trade'])
    payload = dict(classifier=classifier, calibration=calibration, nonTpTemperature=temperature,
                   timeoutRegressor=dict(mean=mean.tolist(), std=std.tolist(), weights=weights.tolist()),
                   stopGapPenaltyScaled=gap_penalty, report=report,
                   parity=dict(features=features[fixture].tolist(), probabilities=raw[fixture].tolist(),
                               timeoutPredictions=timeout_scaled[fixture].tolist()))
    (output / f'raw-model-{horizon}m.json').write_text(json.dumps(payload, allow_nan=False))
    print(json.dumps(dict(horizon=horizon, audit=report['audit'], auditTrades=report['auditTrades'])), flush=True)


if __name__ == '__main__':
    main()
