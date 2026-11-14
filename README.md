# Fareplay

Ask for a ride in a chat. Fareplay checks Waymo, Lyft and Uber on a real iPhone, shows every option with your actual in-app price, and books the cheapest when you say yes. You can watch the phone do it live.

Built at the Do Not Disturb Hackathon x Phone Use (San Francisco, 2026-11-13) on [PhoneUse Local](https://github.com/phoneuse-official/phoneuse).

## How it works

- `rides.py` drives each ride app with a fixed tap sequence mapped on the phone: open the app fresh, type the destination, tap the matching result, then read every ride option's price from the accessibility tree. No model calls, so a three-app check takes about a minute. Pricing never taps Request/Choose; only `book()` can, after the user says yes.
- `relay.py` runs a price check (`ride`), a booking (`book`, with `--dry-run`), or an AI-agent food check (`food`, via PhoneUse's Codex task API). It streams events as JSON lines, saves them to `runs/<id>.jsonl`, and records the phone screen to `runs/<id>.mp4`.
- `app/` is a Next.js chat PWA. It starts relay jobs, streams events over SSE, proxies the phone's live screen as MJPEG, and replays a recorded run (`/replay`) with its real screen recording.

## Run it

1. Set up [PhoneUse Local](https://github.com/phoneuse-official/phoneuse) with a USB iPhone and WebDriverAgent running, and start its API (`./platform/start-api.sh`).
2. Put this repo in the PhoneUse checkout as `race/` (it reads `platform/.state/admin-token` and uses `.venv`). Add `websockets` to the venv if missing; ffmpeg is needed for recordings.
3. Sign in to Uber, Lyft and Waymo on the phone, unlock it, and set Auto-Lock to Never.
4. `cd race/app && npm install && npx next dev -H 0.0.0.0 -p 3210`, then open http://localhost:3210.

Tap coordinates in `rides.py` were mapped on an iPhone 16 Pro; other screen sizes may need remapping.
