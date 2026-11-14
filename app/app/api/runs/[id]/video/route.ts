import { readFile } from "node:fs/promises";
import path from "node:path";
import { RUNS } from "@/lib/race";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9]{6}-[0-9a-f]{4}$/.test(id)) return new Response("bad id", { status: 400 });
  try {
    const video = await readFile(path.join(RUNS, `${id}.mp4`));
    return new Response(video, { headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
