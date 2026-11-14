"""Price relay: run the same request in each app on the local iPhone, one after another.

Usage:
  python race/relay.py ride "I need to get to the Ferry Building right now. What's cheapest?"
  python race/relay.py book Lyft Standard "...to the Ferry Building" [--dry-run]
  python race/relay.py food "pad thai from Thai Idea" --apps DoorDash
  python race/relay.py ride "..." --replay race/runs/<id>.jsonl

Every event is printed and appended to race/runs/<id>.jsonl; the phone screen is saved as race/runs/<id>.mp4.
"""
import argparse
import asyncio
import json
import re
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
from pathlib import Path

import websockets

import rides

API = 'http://127.0.0.1:8765'
ROOT = Path(__file__).resolve().parent
RUNS = ROOT / 'runs'
TOKEN = (ROOT.parent / 'platform/.state/admin-token').read_text().strip()
FFMPEG = shutil.which('ffmpeg') or str(Path.home() / '.local/bin/ffmpeg')

BUNDLES = {
    'DoorDash': 'doordash.DoorDashConsumer',
    'Uber Eats': 'com.ubercab.UberEats',
    'Grubhub': 'com.grubhub.search',
}
FOOD_APPS = ['DoorDash', 'Uber Eats', 'Grubhub']
RIDE_APPS = ['Waymo', 'Lyft', 'Uber']
FOOD_GOAL = ('The {app} app is already open. First check the cart: if it already contains {request}, open the cart and go '
             'straight to checkout. Only if the cart is empty, find {request} and add exactly one to the cart. '
             'Stop on the checkout screen that shows the order total including fees and delivery time. '
             'Do NOT tap Place Order, Pay, or any button that submits the order. '
             'When you can see the total, stop and make your final answer exactly one line: TOTAL: $<amount> | ETA: <minutes> min')
TOTAL_RE = re.compile(r'TOTAL:\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)', re.I)
ETA_RE = re.compile(r'ETA:\s*([0-9]+)', re.I)


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read() or b'null')


def ready_device():
    devices = [d for d in call('GET', '/api/devices')['devices'] if d.get('online')]
    if not devices:
        raise RuntimeError('No phone found. Plug in the iPhone and unlock it.')
    if devices[0].get('automation') == 'not_running':
        raise RuntimeError('The phone is connected but WebDriverAgent is not running.')
    device = devices[0]['id']
    call('POST', f'/api/devices/{device}/lease', {'seconds': 900})
    if call('POST', f'/api/devices/{device}/actions', {'action': 'locked'})['value']:
        raise RuntimeError('The phone is locked. Unlock it and set Auto-Lock to Never.')
    return device


def replay(path, speed):
    previous = 0.0
    for line in Path(path).read_text().splitlines():
        event = json.loads(line)
        time.sleep(max(0.0, event['t'] - previous) / speed)
        previous = event['t']
        print(json.dumps(event), flush=True)


class Recorder:
    def __init__(self, run_id):
        RUNS.mkdir(exist_ok=True)
        self.file = (RUNS / f'{run_id}.jsonl').open('a')
        self.start = time.time()

    def __call__(self, kind, **data):
        event = {'t': round(time.time() - self.start, 2), 'kind': kind, **data}
        self.file.write(json.dumps(event) + '\n')
        self.file.flush()
        print(json.dumps(event), flush=True)
        return event


class ScreenRecorder:
    """Saves the phone's live stream as timestamped JPEGs, then stitches them into <id>.mp4."""

    def __init__(self, device, run_id, start):
        self.device, self.dir, self.start = device, RUNS / run_id, start
        self.video = RUNS / f'{run_id}.mp4'
        self.frames = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=lambda: asyncio.run(self._record()), daemon=True)

    async def _record(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        call('POST', f'/api/devices/{self.device}/view')
        async with websockets.connect(f"{API.replace('http', 'ws')}/api/devices/{self.device}/stream", max_size=None) as ws:
            await ws.send(json.dumps({'token': TOKEN, 'keepalive': True}))
            last = 0.0
            while not self.stop.is_set():
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1)
                except asyncio.TimeoutError:
                    continue
                now = time.time() - self.start
                if isinstance(msg, bytes) and now - last >= 0.2:
                    path = self.dir / f'{len(self.frames):05d}.jpg'
                    path.write_bytes(msg)
                    self.frames.append((path, now))
                    last = now

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(timeout=5)
        if len(self.frames) < 2:
            return
        listing = self.dir / 'frames.txt'
        lines = [f"file '{self.frames[0][0].name}'", f'duration {self.frames[0][1]:.3f}']
        for (path, t), (_, t_next) in zip(self.frames, self.frames[1:] + [(None, self.frames[-1][1] + 0.5)]):
            lines += [f"file '{path.name}'", f'duration {max(t_next - t, 0.04):.3f}']
        listing.write_text('\n'.join(lines + [f"file '{self.frames[-1][0].name}'"]) + '\n')
        subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(listing),
                        '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2,format=yuv420p', '-r', '10', '-c:v', 'libx264',
                        '-movflags', '+faststart', str(self.video)], check=False)
        shutil.rmtree(self.dir, ignore_errors=True)


def price_food_lane(device, app, request, emit, max_steps):
    call('POST', f'/api/devices/{device}/actions', {'action': 'home'})
    call('POST', f'/api/devices/{device}/actions', {'action': 'launch_app', 'bundle_id': BUNDLES[app]})
    time.sleep(2)
    task = call('POST', '/api/ai/tasks', {'device_id': device, 'task': FOOD_GOAL.format(app=app, request=request),
                                          'max_steps': max_steps, 'visual_fallback': True, 'executor': 'baseline'})
    last_stage = None
    while True:
        time.sleep(2)
        record = call('GET', f"/api/ai/tasks/{task['id']}")
        if record.get('stage') != last_stage:
            last_stage = record.get('stage')
            emit('lane_progress', app=app, stage=last_stage, steps=len(record.get('actions') or []))
        if record['status'] != 'running':
            break
    answer = record.get('answer') or ''
    total, eta = TOTAL_RE.search(answer), ETA_RE.search(answer)
    if not total:
        return []
    return [{'tier': app, 'price': float(total.group(1)), 'eta': int(eta.group(1)) if eta else None, 'was': None}]


def run_race(args, device, emit):
    apps = args.apps or (RIDE_APPS if args.mode == 'ride' else FOOD_APPS)
    dest = rides.destination(args.request) if args.mode == 'ride' else args.request
    emit('race_start', category=args.mode, request=args.request, destination=dest, apps=apps)
    phone = rides.Phone(call, device)
    lanes = []
    for app in apps:
        emit('lane_start', app=app)
        steps = iter(range(1, 100))
        step = lambda stage, app=app: emit('lane_progress', app=app, stage=stage, steps=next(steps))
        try:
            options = (rides.PRICERS[app](phone, dest, step) if args.mode == 'ride'
                       else price_food_lane(device, app, args.request, emit, args.max_steps))
            best = options[0] if options else None
            emit('lane_result', app=app, status='completed' if best else 'no_price', options=options,
                 total=best and best['price'], eta=best and best['eta'], tier=best and best['tier'],
                 detail=best and (f"{best['tier']} · promo, was ${best['was']:.2f}" if best['was'] else best['tier']))
            lanes.append((app, options))
        except Exception as exc:
            emit('lane_result', app=app, status='failed', options=[], total=None, error=str(exc)[:200])
    call('POST', f'/api/devices/{device}/actions', {'action': 'home'})

    priced = sorted(((app, o) for app, options in lanes for o in options[:1]), key=lambda x: x[1]['price'])
    if not priced:
        return emit('winner', app=None, total=None, savings=0, standings=[])
    app, best = priced[0]
    emit('winner', app=app, tier=best['tier'], total=best['price'], eta=best['eta'], was=best['was'],
         savings=round(priced[-1][1]['price'] - best['price'], 2), destination=dest,
         standings=[(a, o['price']) for a, o in priced])


def run_book(args, device, emit):
    dest = rides.destination(args.request)
    emit('book_start', app=args.app, tier=args.tier, destination=dest)
    steps = iter(range(1, 100))
    step = lambda stage: emit('lane_progress', app=args.app, stage=stage, steps=next(steps))
    result = rides.book(rides.Phone(call, device), args.app, args.tier, dest, step, dry_run=args.dry_run)
    emit('book_result', app=args.app, tier=args.tier, destination=dest, **result)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='mode', required=True)
    for mode in ('ride', 'food'):
        p = sub.add_parser(mode)
        p.add_argument('request')
        p.add_argument('--apps', nargs='+')
        p.add_argument('--max-steps', type=int, default=40)
        p.add_argument('--replay')
        p.add_argument('--speed', type=float, default=1.0)
    p = sub.add_parser('book')
    p.add_argument('app', choices=list(rides.PRICERS))
    p.add_argument('tier')
    p.add_argument('request')
    p.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if getattr(args, 'replay', None):
        return replay(args.replay, args.speed)

    run_id = time.strftime('%H%M%S-') + uuid.uuid4().hex[:4]
    emit = Recorder(run_id)
    emit('run', run_id=run_id, mode=args.mode)
    try:
        device = ready_device()
    except Exception as exc:
        return emit('race_error', message=str(exc))
    with ScreenRecorder(device, run_id, emit.start):
        (run_book if args.mode == 'book' else run_race)(args, device, emit)
    emit('video', run_id=run_id, ready=(RUNS / f'{run_id}.mp4').exists())


if __name__ == '__main__':
    main()
