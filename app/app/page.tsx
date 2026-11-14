"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Option, RaceEvent } from "@/lib/race";

const DEMO_PROMPT = "I need to get to the Ferry Building right now. What's cheapest?";
const YES = /^(y|yes|yeah|yep|sure|ok|okay|book it|do it|go)\b/i;
const NO = /^(n|no|nah|nope|cancel)\b/i;

type Lane = { app: string; state: "pending" | "running" | "done"; stage?: string | null; best?: Option | null; options: Option[] };
type Race = { destination: string; apps: string[]; lanes: Record<string, Lane> };
type Winner = Extract<RaceEvent, { kind: "winner" }>;
type Item =
  | { id: string; kind: "me"; text: string }
  | { id: string; kind: "bot"; text: string; watch?: boolean }
  | { id: string; kind: "race"; race: Race }
  | { id: string; kind: "results"; race: Race; winner: Winner }
  | { id: string; kind: "offer"; winner: Winner; open: boolean };

function derive(events: RaceEvent[]) {
  const items: Item[] = [];
  let race = null as Race | null;
  let replay = false;
  let runId = null as string | null;
  let active = null as { app: string; stage: string | null } | null;
  let offer = null as Extract<Item, { kind: "offer" }> | null;
  let busy = false;

  events.forEach((e, i) => {
    const id = String(i);
    switch (e.kind) {
      case "user":
        items.push({ id, kind: "me", text: e.text });
        busy = true;
        if (offer) offer.open = false;
        break;
      case "run":
        runId = e.run_id;
        replay = !!e.replay;
        if (replay) items.push({ id, kind: "bot", text: "Replaying a recorded run from earlier today (real phone footage)." });
        break;
      case "race_start":
        race = { destination: e.destination, apps: e.apps, lanes: Object.fromEntries(e.apps.map((a) => [a, { app: a, state: "pending", options: [] }])) };
        items.push({
          id,
          kind: "bot",
          text: replay
            ? `Here's how it went checking ${e.apps.join(", ")} for a ride to ${e.destination}.`
            : `Checking ${e.apps.join(", ")} for a ride to ${e.destination}. I'm doing it on my phone right now.`,
          watch: true,
        });
        items.push({ id: id + "r", kind: "race", race });
        break;
      case "lane_start":
        if (race?.lanes[e.app]) race.lanes[e.app] = { ...race.lanes[e.app], state: "running", stage: "opening" };
        active = { app: e.app, stage: "opening" };
        break;
      case "lane_progress":
        if (race?.lanes[e.app]) race.lanes[e.app] = { ...race.lanes[e.app], stage: e.stage };
        active = { app: e.app, stage: e.stage };
        break;
      case "lane_result":
        if (race?.lanes[e.app]) race.lanes[e.app] = { ...race.lanes[e.app], state: "done", options: e.options ?? [], best: e.options?.[0] ?? null };
        active = null;
        break;
      case "winner":
        active = null;
        if (race && e.app && e.total !== null) {
          items.push({ id, kind: "results", race, winner: e });
          offer = { id: id + "o", kind: "offer", winner: e, open: !replay };
          items.push(offer);
        } else items.push({ id, kind: "bot", text: "I couldn't get a price from any app this time." });
        break;
      case "race_error":
        items.push({ id, kind: "bot", text: `I can't reach my phone right now. ${e.message}` });
        break;
      case "book_start":
        items.push({ id, kind: "bot", text: `Booking ${e.app} ${e.tier} to ${e.destination}…`, watch: true });
        break;
      case "book_result": {
        const price = e.quote ? ` for $${e.quote.price.toFixed(2)}` : "";
        const text =
          e.status === "booked"
            ? `Booked ✅ ${e.app} ${e.tier} to ${e.destination}${price}. Your driver is on the way.`
            : e.status === "unconfirmed"
              ? `I tapped "${e.tapped}" in ${e.app}, but couldn't confirm a driver yet. Check the phone.`
              : e.status === "dry_run"
                ? `Ready to book ${e.app} ${e.tier}${price} (dry run, nothing tapped).`
                : `I couldn't book it in ${e.app} (${e.status}).`;
        items.push({ id, kind: "bot", text });
        break;
      }
      case "declined":
        busy = false;
        items.push({ id, kind: "bot", text: "No problem. Just ask when you need a ride." });
        break;
      case "job_end":
        busy = false;
        active = null;
        break;
    }
  });
  return { items, race, replay, runId, active, offer, busy };
}

const money = (n: number) => `$${n.toFixed(2)}`;

export default function Chat() {
  const [events, setEvents] = useState<RaceEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const source = new EventSource("/api/race/events");
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RaceEvent;
      setEvents((prev) => (event.kind === "user" && prev.at(-1)?.kind === "job_end" && !prev.some((p) => p.kind === "winner" && p.app) ? [event] : [...prev, event]));
    };
    return () => source.close();
  }, []);

  const view = useMemo(() => derive(events), [events]);
  const { items, race, replay, runId, active, offer, busy } = view;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length, active?.stage]);

  async function post(body: object) {
    setError(null);
    const res = await fetch("/api/race", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setError(((await res.json()) as { error: string }).error);
  }

  function send(text: string) {
    const t = text.trim();
    if (!t) return;
    setDraft("");
    if (offer?.open && YES.test(t) && offer.winner.app && offer.winner.tier) return post({ text: t, book: { app: offer.winner.app, tier: offer.winner.tier } });
    if (offer?.open && NO.test(t)) return post({ text: t, decline: true });
    setEvents([]);
    post({ text: t });
  }

  return (
    <div className="flex h-dvh bg-neutral-950 text-neutral-100">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 pb-3 pt-[max(env(safe-area-inset-top),12px)]">
          <div>
            <h1 className="text-lg font-semibold">Fareplay</h1>
            <p className="text-xs text-neutral-400">{active ? `In ${active.app} · ${active.stage ?? "working"}` : "Your price, inside every app"}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setWatching(true)} className="flex items-center gap-1.5 rounded-full bg-neutral-800 px-3 py-1.5 text-sm font-medium lg:hidden">
              {active && <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />}
              Watch
            </button>
            <button
              onClick={async () => {
                const res = await fetch("/api/race", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reset: true }) });
                if (res.ok) {
                  setEvents([]);
                  setDraft("");
                  setError(null);
                  setWatching(false);
                } else setError(((await res.json()) as { error: string }).error);
              }}
              disabled={busy}
              className="rounded-full bg-neutral-800 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              New chat
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {items.length === 0 && (
            <div className="mt-16 flex flex-col items-center gap-3 text-center text-neutral-400">
              <p className="text-base text-neutral-200">Where do you need to go?</p>
              <button onClick={() => send(DEMO_PROMPT)} className="rounded-full border border-neutral-700 px-4 py-2 text-sm text-neutral-200">
                {DEMO_PROMPT}
              </button>
            </div>
          )}
          {items.map((item) => (
            <ItemView key={item.id} item={item} onWatch={() => setWatching(true)} onAnswer={send} busy={busy} />
          ))}
          {error && <p className="text-center text-sm text-red-400">{error}</p>}
          <div ref={bottom} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
          className="flex gap-2 border-t border-neutral-800 px-3 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={busy ? "Working on it…" : offer?.open ? "Say yes to book it" : "Where do you need to go?"}
            disabled={busy}
            className="min-w-0 flex-1 rounded-full bg-neutral-800 px-4 py-2.5 text-base outline-none placeholder:text-neutral-500 disabled:opacity-50"
          />
          <button disabled={busy || !draft.trim()} className="rounded-full bg-emerald-500 px-4 font-medium text-black disabled:opacity-40">
            Send
          </button>
        </form>
      </main>

      <aside className="hidden w-[440px] shrink-0 flex-col items-center justify-center gap-4 border-l border-neutral-800 p-6 lg:flex">
        <Screen replay={replay} runId={runId} />
        <LaneStrip race={race} active={active} />
      </aside>

      {watching && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/95 p-4">
          <LaneStrip race={race} active={active} />
          <Screen replay={replay} runId={runId} />
          <button onClick={() => setWatching(false)} className={`rounded-full px-5 py-2.5 font-medium ${offer?.open || !busy ? "bg-emerald-500 text-black" : "bg-neutral-800"}`}>
            {offer?.open ? "Results are in · back to chat" : "Back to chat"}
          </button>
        </div>
      )}
    </div>
  );
}

function Screen({ replay, runId }: { replay: boolean; runId: string | null }) {
  return (
    <div className="relative aspect-[402/874] h-[min(68dvh,760px)] overflow-hidden rounded-[2.5rem] border-[6px] border-neutral-700 bg-black">
      {replay && runId ? (
        <video key={runId} src={`/api/runs/${runId}/video`} autoPlay muted playsInline className="h-full w-full object-contain" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/api/phone/stream" alt="Live iPhone screen" className="h-full w-full object-contain" />
      )}
      <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2 py-0.5 text-xs">
        {replay ? "Recorded" : <><span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />Live</>}
      </span>
    </div>
  );
}

function LaneStrip({ race, active }: { race: Race | null; active: { app: string; stage: string | null } | null }) {
  if (!race) return <p className="text-sm text-neutral-400">My phone</p>;
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-sm text-neutral-300">{active ? `Now in ${active.app} · ${active.stage ?? "working"}` : "Done"}</p>
      <div className="flex gap-2">
        {race.apps.map((app) => {
          const lane = race.lanes[app];
          return (
            <span
              key={app}
              className={`rounded-full px-3 py-1 text-xs ${lane.state === "running" ? "animate-pulse bg-emerald-500 text-black" : lane.state === "done" ? "bg-neutral-700" : "bg-neutral-900 text-neutral-500"}`}
            >
              {app}
              {lane.best ? ` ${money(lane.best.price)}` : lane.state === "done" ? " –" : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ItemView({ item, onWatch, onAnswer, busy }: { item: Item; onWatch: () => void; onAnswer: (t: string) => void; busy: boolean }) {
  if (item.kind === "me") return <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-500 px-3 py-2 text-black">{item.text}</div>;
  if (item.kind === "bot")
    return (
      <div className="w-fit max-w-[85%] space-y-2 rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2">
        <p>{item.text}</p>
        {item.watch && (
          <button onClick={onWatch} className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 text-sm font-medium text-black">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Watch it work
          </button>
        )}
      </div>
    );
  if (item.kind === "race")
    return (
      <div className="w-fit min-w-64 space-y-1 rounded-2xl rounded-bl-sm bg-neutral-900 px-3 py-2 text-sm">
        {item.race.apps.map((app) => {
          const lane = item.race.lanes[app];
          return (
            <div key={app} className="flex justify-between gap-6">
              <span className={lane.state === "pending" ? "text-neutral-500" : ""}>{app}</span>
              <span className="tabular-nums text-neutral-300">
                {lane.state === "pending" ? "waiting" : lane.state === "running" ? <span className="animate-pulse">{lane.stage ?? "working"}…</span> : lane.best ? money(lane.best.price) : "no price"}
              </span>
            </div>
          );
        })}
      </div>
    );
  if (item.kind === "results") {
    const { race, winner } = item;
    const groups = race.apps.map((app) => race.lanes[app]).filter((l) => l.options.length).sort((a, b) => a.options[0].price - b.options[0].price);
    return (
      <div className="w-full max-w-md space-y-3 rounded-2xl rounded-bl-sm border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
        <div>
          <p className="text-sm text-emerald-300">Cheapest right now</p>
          <p className="text-xl font-semibold">
            {winner.app} {winner.tier} · {money(winner.total!)}
          </p>
          <p className="text-sm text-neutral-300">
            {winner.eta ? `${winner.eta} min away` : ""}
            {winner.was ? ` · promo, was ${money(winner.was)}` : ""}
            {winner.savings > 0 ? ` · saves ${money(winner.savings)}` : ""}
          </p>
        </div>
        {groups.map((lane) => (
          <div key={lane.app}>
            <p className="mb-1 text-xs uppercase tracking-wide text-neutral-500">{lane.app}</p>
            {lane.options.map((o) => (
              <div key={o.tier} className={`flex justify-between gap-4 text-sm tabular-nums ${lane.app === winner.app && o.tier === winner.tier ? "font-semibold text-emerald-300" : "text-neutral-300"}`}>
                <span>{o.tier}</span>
                <span>
                  {o.was && <span className="mr-2 text-xs text-neutral-500 line-through">{money(o.was)}</span>}
                  {money(o.price)}
                  {o.eta !== null && <span className="ml-2 text-xs text-neutral-500">{o.eta} min</span>}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  const { winner, open } = item;
  return (
    <div className="w-fit max-w-[85%] space-y-2 rounded-2xl rounded-bl-sm bg-neutral-800 px-3 py-2">
      <p>
        Want me to book {winner.app} {winner.tier} for {money(winner.total!)}?
      </p>
      {open && !busy && (
        <div className="flex gap-2">
          <button onClick={() => onAnswer("Yeah, book it")} className="rounded-full bg-emerald-500 px-3 py-1.5 text-sm font-medium text-black">
            Book it
          </button>
          <button onClick={() => onAnswer("No thanks")} className="rounded-full bg-neutral-700 px-3 py-1.5 text-sm">
            No thanks
          </button>
        </div>
      )}
    </div>
  );
}
