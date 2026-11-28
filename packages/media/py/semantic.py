"""FRAME semantic worker (Phase 5): MediaPipe Tasks on sampled frames, CPU.

Reads raw RGB frames from an FFmpeg pipe and prints one JSON object per frame:
  {"t": s, "objects": [[label, score, x, y, w, h]], "faces": [[score, x, y, w, h]],
   "poses": [{"box": [x, y, w, h], "kp": {name: [x, y, visibility]}}],
   "hands": [[gesture, score, handedness, x, y, w, h]], "emb": [..], "embL": [..], "cls": [[i, p]]}
Boxes are normalized, top-left origin. Nothing is identified: faces are locations only.
Usage: semantic.py MODELS FFMPEG FILE FPS W H MAXSEC TASKS(comma list) [START_SECONDS]
"""
import json
import resource
import subprocess
import sys
import time

import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

models, ffmpeg, src, fps, W, H, maxsec, tasks = sys.argv[1:9]
start = sys.argv[9] if len(sys.argv) > 9 else '0'
W, H, fps = int(W), int(H), float(fps)
tasks = set(tasks.split(','))
t_load = time.time()
opt = lambda f: BaseOptions(model_asset_path=f"{models}/{f}")
det = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(base_options=opt('efficientdet_lite0.tflite'), score_threshold=0.3, max_results=15)) if 'objects' in tasks else None
face = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(base_options=opt('blaze_face_short_range.tflite'), min_detection_confidence=0.5)) if 'faces' in tasks else None
pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=opt('pose_landmarker_lite.task'), num_poses=4)) if 'pose' in tasks else None
ges = vision.GestureRecognizer.create_from_options(vision.GestureRecognizerOptions(base_options=opt('gesture_recognizer.task'), num_hands=2)) if 'gestures' in tasks else None
embl = vision.ImageEmbedder.create_from_options(vision.ImageEmbedderOptions(base_options=opt('mobilenet_v3_large.tflite'), l2_normalize=True)) if 'scene' in tasks else None
cls2 = vision.ImageClassifier.create_from_options(vision.ImageClassifierOptions(base_options=opt('efficientnet_lite2.tflite'), max_results=1001)) if 'scene' in tasks else None
emb = vision.ImageEmbedder.create_from_options(vision.ImageEmbedderOptions(base_options=opt('mobilenet_v3_small.tflite'), l2_normalize=True)) if 'embed' in tasks else None
print(json.dumps({"ready": True, "loadMs": int((time.time() - t_load) * 1000)}), flush=True)

KP = {"nose": 0, "ls": 11, "rs": 12, "le": 13, "re": 14, "lw": 15, "rw": 16, "lh": 23, "rh": 24, "lk": 25, "rk": 26, "la": 27, "ra": 28}
r3 = lambda v: round(float(v), 3)
# Output-side seek keeps the source timestamps, so fps sampling lands exactly on start + n/fps
# (an input-side seek re-bases time and the fps filter then picks a different frame).
seek = ['-i', src, '-ss', start, '-t', maxsec] if float(start) > 0 else ['-t', maxsec, '-i', src]
# Take the first frame at or after each sampling instant. (The fps filter keeps the LAST frame of each
# slot when downsampling, so its "2.5 s" frame at 0.4 fps was really ~3.7 s, and up to +0.25 s at 2 fps.)
step = 1.0 / fps - 0.002
sel = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{step:.4f})',scale={W}:{H}"
p = subprocess.Popen([ffmpeg, '-v', 'error', *seek, '-an', '-vf', sel, '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
n, size = 0, W * H * 3
while True:
    buf = p.stdout.read(size)
    if not buf or len(buf) < size:
        break
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3))
    out = {"t": r3(float(start) + n / fps)}
    t0 = time.time()
    if det:
        out["objects"] = [[d.categories[0].category_name, r3(d.categories[0].score), r3(d.bounding_box.origin_x / W), r3(d.bounding_box.origin_y / H), r3(d.bounding_box.width / W), r3(d.bounding_box.height / H)] for d in det.detect(img).detections]
    if face:
        out["faces"] = [[r3(d.categories[0].score), r3(d.bounding_box.origin_x / W), r3(d.bounding_box.origin_y / H), r3(d.bounding_box.width / W), r3(d.bounding_box.height / H)] for d in face.detect(img).detections]
    if pose:
        ps = []
        for lm in pose.detect(img).pose_landmarks:
            vis = [l for l in lm if (l.visibility or 0) > 0.5]
            if len(vis) < 5:
                continue
            xs, ys = [min(1, max(0, l.x)) for l in vis], [min(1, max(0, l.y)) for l in vis]
            ps.append({"box": [r3(min(xs)), r3(min(ys)), r3(max(xs) - min(xs)), r3(max(ys) - min(ys))],
                       "kp": {k: [r3(lm[i].x), r3(lm[i].y), r3(lm[i].visibility or 0)] for k, i in KP.items()}})
        out["poses"] = ps
    if ges:
        g = ges.recognize(img)
        hs = []
        for k, lms in enumerate(g.hand_landmarks):
            xs, ys = [l.x for l in lms], [l.y for l in lms]
            top = g.gestures[k][0] if g.gestures and g.gestures[k] else None
            hs.append([top.category_name if top else 'None', r3(top.score if top else 0), g.handedness[k][0].category_name if g.handedness else '?', r3(min(xs)), r3(min(ys)), r3(max(xs) - min(xs)), r3(max(ys) - min(ys))])
        out["hands"] = hs
    if emb:
        out["emb"] = [round(float(v), 4) for v in emb.embed(img).embeddings[0].embedding]
    if embl:
        out["embL"] = [round(float(v), 4) for v in embl.embed(img).embeddings[0].embedding]
        # ImageNet classes with p >= 1e-4 as [index, probability] (the rest are ~0)
        out["cls"] = [[c.index, round(float(c.score), 5)] for c in cls2.classify(img).classifications[0].categories if c.score >= 1e-4]
    out["ms"] = int((time.time() - t0) * 1000)
    print(json.dumps(out), flush=True)
    n += 1
p.wait()
print(json.dumps({"done": True, "frames": n, "ffmpegExit": p.returncode, "maxRssMB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)}), flush=True)
