#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import sys

import numpy as np
import xgboost as xgb

QUANTILES = np.array([0.25, 0.5, 0.75])


def quantile_metrics(y, predictions):
    residual = y[:, None] - predictions
    losses = np.maximum(QUANTILES * residual, (QUANTILES - 1) * residual)
    return dict(samples=len(y), meanPinballLoss=float(losses.mean()),
                coverage=(y[:, None] <= predictions).mean(axis=0).tolist())


def adjusted(predictions, offsets):
    return np.sort(np.maximum(0, predictions + offsets), axis=1)


def main():
    source = json.loads(pathlib.Path(sys.argv[1]).read_text())
    output = pathlib.Path(sys.argv[2])
    spec = importlib.util.spec_from_file_location('portable', pathlib.Path(__file__).with_name('research-predictive-direction.py'))
    portable = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(portable)
    x = np.asarray(source['features'], dtype=np.float32)
    times = np.asarray(source['times'], dtype=np.int64)
    for horizon_text, labels in source['horizons'].items():
        horizon = int(horizon_text)
        boundaries = labels['boundaries']
        scale = np.asarray(labels['scalePct'], dtype=float)
        train = times + horizon * 60000 < boundaries['validationStart']
        validation = (times >= boundaries['validationStart']) & (times + horizon * 60000 < boundaries['holdoutStart'])
        holdout = (times >= boundaries['holdoutStart']) & np.isfinite(np.asarray(labels['upPct'], dtype=float))
        estimators, reports, parity = {}, {}, {}
        for side in ['up', 'down']:
            y = np.asarray(labels[side + 'Pct'], dtype=float) / scale
            if np.sum(train) < 500 or np.sum(validation) < 100 or np.sum(holdout) < 100:
                raise ValueError('Insufficient excursion history')
            booster = xgb.train(dict(objective='reg:quantileerror', quantile_alpha=QUANTILES.tolist(),
                                    tree_method='hist', nthread=2, seed=29, base_score=0.5,
                                    max_depth=3, eta=0.05, min_child_weight=100, reg_lambda=20,
                                    subsample=0.85, colsample_bytree=0.9, max_bin=128),
                                xgb.DMatrix(x[train], label=y[train], nthread=2), num_boost_round=140)
            raw_val = booster.predict(xgb.DMatrix(x[validation], nthread=2)).astype(float)
            raw_holdout = booster.predict(xgb.DMatrix(x[holdout], nthread=2)).astype(float)
            offsets = np.array([np.quantile(y[validation] - raw_val[:, i], alpha)
                                for i, alpha in enumerate(QUANTILES)])
            tree_val = quantile_metrics(y[validation], adjusted(raw_val, offsets))
            constants = np.quantile(y[train], QUANTILES)
            constant_offsets = np.array([np.quantile(y[validation] - constants[i], alpha)
                                         for i, alpha in enumerate(QUANTILES)])
            constant_val = quantile_metrics(y[validation], adjusted(np.tile(constants, (np.sum(validation), 1)), constant_offsets))
            classifier = portable.export_classifier(booster, x.shape[1])
            classifier['kind'] = 'boosted-quantile-trees-v1'
            use_trees = tree_val['meanPinballLoss'] < constant_val['meanPinballLoss']
            estimators[side] = dict(regressor=classifier if use_trees else
                                   dict(kind='quantile-constant-v1', values=constants.tolist()),
                                   offsets=(offsets if use_trees else constant_offsets).tolist())
            selected_holdout = adjusted(raw_holdout, offsets) if use_trees else adjusted(
                np.tile(constants, (np.sum(holdout), 1)), constant_offsets)
            reports[side] = dict(selectedOn='VALIDATION_PINBALL_LOSS', selected='CONTEXT_TREES' if use_trees else 'VOLATILITY_NORMALIZED_EMPIRICAL',
                                 validationTrees=tree_val, validationEmpirical=constant_val,
                                 holdout=quantile_metrics(y[holdout], selected_holdout),
                                 units='Local volatility scaled excursion')
            indices = np.unique(np.linspace(0, np.sum(np.isfinite(y)) - 1, 30, dtype=int))
            parity[side] = dict(classifier=classifier, features=x[indices].tolist(),
                                predictions=booster.predict(xgb.DMatrix(x[indices], nthread=2)).tolist())
            print(json.dumps(dict(horizon=horizon, side=side, method=reports[side]['selected'])), flush=True)
        (output / f'raw-exits-{horizon}m.json').write_text(json.dumps(dict(
            estimators=estimators, report=reports, parity=parity), allow_nan=False))


if __name__ == '__main__':
    main()
