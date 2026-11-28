"""Phase 6 scene classifier training (offline, numpy only).

    python3 bench/phase6/scene-train.py <feat-train.json[,more.json]> [--write]

Features come from the production worker (bench/phase6/scene-features.ts, tasks incl. "scene").
Model selection: grouped (by clip) 8-fold cross-validation on TRAIN only; the chosen L2 strength is
then fit on all training frames and written to packages/media/data/scene-model.json. The test set is
never read here.
"""
import json, sys, os
import numpy as np

C = ['talking-head', 'group', 'performance', 'screen', 'animation', 'sports', 'close-up', 'scenery']
rows = [r for f in sys.argv[1].split(',') for r in json.load(open(f)) if r['label'] and r['frame'].get('embL')]

def feats(f):
    cls = np.zeros(1001)
    for i, p in f['cls']:
        cls[i] = np.sqrt(p)
    fa = f.get('faces', []); pe = [o for o in f.get('objects', []) if o[0] == 'person']; po = f.get('poses', [])
    det = [min(len(fa), 3) / 3, min(1, max([x[3] * x[4] for x in fa] + [0]) * 15), min(len(pe), 6) / 6,
           min(1, max([p[4] * p[5] for p in pe] + [0]) * 2), min(len(po), 4) / 4, min(1, max([p['box'][2] * p['box'][3] for p in po] + [0]) * 2)]
    ha = f.get('hands', []); no = [o for o in f.get('objects', []) if o[0] != 'person']
    # Phase 7 extra detection features (hands, large people, faces, non-person objects).
    ext = [min(len(ha), 2) / 2, min(1, max([h[5] * h[6] for h in ha] + [0]) * 10), sum(1 for p in pe if p[4] * p[5] > 0.05) / 4,
           min(1, sum(p[4] * p[5] for p in pe)), sum(1 for x in fa if x[3] * x[4] > 0.005) / 3, min(1, max([o[4] * o[5] for o in no] + [0]) * 2), min(len(no), 6) / 6]
    return np.concatenate([f['embL'], cls, det, ext])

X = np.array([feats(r['frame']) for r in rows]); Y = np.array([C.index(r['label']) for r in rows]); ids = [r['id'] for r in rows]
clips = sorted(set(ids)); fold = {c: i % 8 for i, c in enumerate(clips)}; Fo = np.array([fold[i] for i in ids])

def fit(Z, Yt, l2, it=500, lr=0.1):
    K = len(C); W = np.zeros((Z.shape[1], K)); b = np.zeros(K)
    cnt = np.bincount(Yt, minlength=K); cw = np.where(cnt > 0, len(Yt) / (K * np.maximum(cnt, 1)), 0); w = cw[Yt]; O = np.eye(K)[Yt]
    for _ in range(it):
        z = Z @ W + b; z -= z.max(1, keepdims=True); p = np.exp(z); p /= p.sum(1, keepdims=True)
        g = (p - O) * w[:, None]; W -= lr * (Z.T @ g / w.sum() + l2 * W); b -= lr * g.sum(0) / w.sum()
    return W, b

res = {}
for l2 in [1e-1, 0.3, 1.0]:
    ok = 0
    for f in range(8):
        tr, te = Fo != f, Fo == f
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
        W, b = fit((X[tr] - mu) / sd, Y[tr], l2)
        ok += (((X[te] - mu) / sd @ W + b).argmax(1) == Y[te]).sum()
    res[l2] = round(ok / len(Y), 3)
best = max(res, key=lambda k: res[k])
print(json.dumps({'frames': len(Y), 'clips': len(clips), 'cv': res, 'chosenL2': best}))
if '--write' in sys.argv:
    mu, sd = X.mean(0), X.std(0) + 1e-6
    W, b = fit((X - mu) / sd, Y, best)
    model = {'classes': C, 'dims': X.shape[1], 'mu': [float(f'{v:.6g}') for v in mu], 'sd': [float(f'{v:.6g}') for v in sd],
             'W': [[float(f'{v:.4g}') for v in W[:, k]] for k in range(len(C))], 'b': [round(float(v), 4) for v in b],
             'meta': {'trainedOn': f'{len(Y)} frames from {len(clips)} UGC clips (bench/phase6/scene-train-labels.json)', 'selection': f'grouped 8-fold CV accuracy by L2: {res}', 'l2': best,
                      'features': 'MobileNetV3-large embedding (1280) + sqrt EfficientNet-Lite2 class probabilities >= 1e-4 (1001) + 6 detection counts + 7 Phase 7 detection features (hands, large people, faces, objects)'}}
    out = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'media', 'data', 'scene-model.json')
    os.makedirs(os.path.dirname(out), exist_ok=True); json.dump(model, open(out, 'w'), separators=(',', ':'))
    print('wrote', out, os.path.getsize(out))
