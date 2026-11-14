import { subscribe } from "@/lib/race";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = subscribe((event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
      const ping = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15000);
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(ping);
        controller.close();
      });
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
