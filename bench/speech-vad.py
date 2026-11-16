"""Optional Linux measurement harness (Python stdlib + FFmpeg flite + local Whisper).
No model download. Run from repo root: python bench/speech-vad.py /tmp/tmep-speech-proof
CPU/RSS include child processes. Use an idle machine; results are observations, not claims.
"""
import json, os, pathlib, resource, subprocess, sys, time

if len(sys.argv) > 1 and sys.argv[1] == '--measure':
    start = time.perf_counter()
    p = subprocess.run(sys.argv[3:], capture_output=True, text=True)
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    pathlib.Path(sys.argv[2]).write_text(json.dumps({'wallSeconds': time.perf_counter()-start,
        'cpuSeconds': usage.ru_utime+usage.ru_stime, 'peakChildRssKiB': usage.ru_maxrss,
        'exitCode': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}))
    sys.exit(0)

root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
cli = str(pathlib.Path('bin/tmep.js').resolve())
def run(args):
    p = subprocess.run(args, text=True, capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr + p.stdout)
    return p.stdout
def tmep(*args):
    return json.loads(run(['node', cli, '-p', str(root), *args]))
texts = ['Keep the original files. Make a copy before editing.',
         'Review the captions. Export the video after checking the sound.']
for i, text in enumerate(texts):
    wav = root / f'speech {i}.wav'
    if (root / f'clip {i}.mp4').exists(): continue
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'flite=text={text}', '-ar', '16000', str(wav)])
    # Silence before/after speech makes source-coordinate errors observable.
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=180x320:r=30', '-i', str(wav),
         '-filter_complex', '[1:a]adelay=2000|2000,apad=pad_dur=3[a]', '-map', '0:v', '-map', '[a]',
         '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', str(root / f'clip {i}.mp4')])
assets = tmep('import', str(root/'clip 0.mp4'), str(root/'clip 1.mp4'))
ids = [a['id'] for a in assets['assets']]
measurements = {}
for mode in ['off', 'on', 'verify', 'cached']:
    out = root / f'{mode}-measurement.json'
    args = ['node', cli, '-p', str(root), 'transcribe-batch', *ids, '--engine', 'whisper.cpp', '--lang', 'en', '--vad', 'on' if mode == 'cached' else mode]
    # Warm WAV extraction with the existing FFmpeg helper before measurements.
    if mode == 'off' and not out.exists():
        code = "import {Project} from './packages/core/src/index.ts'; import {extractSpeechWav} from './packages/media/src/ffmpeg.ts'; const p=await Project.open(process.argv[1]);for(const a of await p.assets())await extractSpeechWav(a.path,p.cachePath('wav',a.hash+'.wav'));"
        run(['node', '--input-type=module', '-e', code, str(root)])
    if mode != 'cached': args.append('--force')
    if not out.exists(): run([sys.executable, __file__, '--measure', str(out), *args])
    m = json.loads(out.read_text())
    result = json.loads(m.pop('stdout')); m.pop('stderr')
    if m['exitCode'] or result['failures']: raise RuntimeError(json.dumps(result))
    m['manifestBytes'] = len(json.dumps(result, separators=(',', ':'), ensure_ascii=False).encode())
    m['assets'] = result['assets']
    for a in result['assets']:
        tr = json.loads((root / a['tr']).read_text())
        (root / f'{mode}-{a["id"]}.json').write_text(json.dumps(tr, ensure_ascii=False))
    measurements[mode] = m
# A raw workflow, using the same registered speech clips and cached words.
edit = tmep('inspect', 'timeline')
if not edit.get('dur'): edit = tmep('edit', *['add '+i for i in ids], 'captions clean')
render = tmep('render', '--preview', '--out', 'edited.mp4')
probe = json.loads(run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', str(root/'edited.mp4')]))
report = {'referenceText': texts, 'speechStartsAfterSeconds': 2, 'measurements': measurements, 'edit': edit, 'render': render, 'probe': probe}
(root / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
print(json.dumps({'report': str(root/'report.json'), 'modes': {k:{x:v[x] for x in ['wallSeconds','cpuSeconds','peakChildRssKiB','manifestBytes']} for k,v in measurements.items()}, 'render':render}, indent=2))
