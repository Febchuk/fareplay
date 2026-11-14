import { ask, book, decline, reset } from "@/lib/race";

export async function POST(req: Request) {
  const body = (await req.json()) as { text?: string; book?: { app: string; tier: string }; decline?: boolean; reset?: boolean };
  const text = body.text?.trim() || "";
  try {
    if (body.reset) reset();
    else if (body.book) book(body.book.app, body.book.tier, text || "Yes, book it");
    else if (body.decline) decline(text || "No thanks");
    else if (text) ask(text);
    else return Response.json({ error: "Say where you want to go" }, { status: 400 });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
}
