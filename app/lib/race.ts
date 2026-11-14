import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

export type Option = { tier: string; price: number; eta: number | null; was: number | null };

export type RaceEvent =
  | { t: number; kind: "user"; text: string }
  | { t: number; kind: "run"; run_id: string; mode: string; replay?: boolean }
  | { t: number; kind: "race_start"; category: string; request: string; destination: string; apps: string[] }
  | { t: number; kind: "race_error"; message: string }
  | { t: number; kind: "lane_start"; app: string }
  | { t: number; kind: "lane_progress"; app: string; stage: string | null; steps: number }
  | { t: number; kind: "lane_result"; app: string; status: string; total: number | null; eta?: number | null; tier?: string | null; detail?: string | null; options?: Option[]; error?: string | null }
  | { t: number; kind: "winner"; app: string | null; tier?: string; total: number | null; eta?: number | null; was?: number | null; savings: number; destination?: string; standings: [string, number][] }
  | { t: number; kind: "book_start"; app: string; tier: string; destination: string }
  | { t: number; kind: "book_result"; app: string; tier: string; destination: string; status: string; quote?: Option; tapped?: string }
  | { t: number; kind: "video"; run_id: string; ready: boolean }
  | { t: number; kind: "declined" }
  | { t: number; kind: "job_end"; code: number | null };

type State = { events: RaceEvent[]; proc: ChildProcess | null; listeners: Set<(e: RaceEvent) => void>; lastRequest: string | null; replaying: boolean };

const RACE_DIR = path.resolve(process.cwd(), "..");
const REPO = path.resolve(RACE_DIR, "..");
export const RUNS = path.join(RACE_DIR, "runs");

const g = globalThis as unknown as { __race2?: State };
const state: State = (g.__race2 ??= { events: [], proc: null, listeners: new Set(), lastRequest: null, replaying: false });

function publish(event: RaceEvent) {
  state.events.push(event);
  for (const listener of state.listeners) listener(event);
}

function latestGoodRun() {
  const runs = readdirSync(RUNS).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  return runs.find((f) => {
    const text = readFileSync(path.join(RUNS, f), "utf8");
    return /"kind": "winner", "app": "/.test(text) && /"options"/.test(text);
  });
}

function spawnRelay(args: string[], replay: boolean) {
  state.replaying = replay;
  const proc = spawn(path.join(REPO, ".venv/bin/python"), ["-u", "race/relay.py", ...args], { cwd: REPO });
  state.proc = proc;
  createInterface({ input: proc.stdout! }).on("line", (line) => {
    try {
      const event = JSON.parse(line) as RaceEvent;
      publish(event.kind === "run" && replay ? { ...event, replay: true } : event);
    } catch {
      console.log("[relay]", line);
    }
  });
  proc.stderr!.on("data", (chunk) => console.error("[relay]", String(chunk)));
  proc.on("close", (code) => {
    state.proc = null;
    publish({ t: 0, kind: "job_end", code });
  });
}

export function ask(text: string) {
  if (state.proc) throw new Error("Still working on the last one. Hang on.");
  state.events = [];
  publish({ t: 0, kind: "user", text });
  if (text.trim().toLowerCase().startsWith("/replay")) {
    const run = latestGoodRun();
    if (!run) throw new Error("No recorded run yet");
    return spawnRelay(["ride", "replay", "--replay", path.join(RUNS, run)], true);
  }
  state.lastRequest = text;
  spawnRelay(["ride", text], false);
}

export function book(app: string, tier: string, text: string) {
  if (state.proc) throw new Error("Still working on the last one. Hang on.");
  if (state.replaying || !state.lastRequest) throw new Error("Booking is off for replays");
  publish({ t: 0, kind: "user", text });
  spawnRelay(["book", app, tier, state.lastRequest], false);
}

export function reset() {
  if (state.proc) throw new Error("Wait for the phone to finish first.");
  state.events = [];
  state.lastRequest = null;
  state.replaying = false;
}

export function decline(text: string) {
  publish({ t: 0, kind: "user", text });
  publish({ t: 0, kind: "declined" });
}

export function subscribe(listener: (e: RaceEvent) => void) {
  state.events.forEach(listener);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
