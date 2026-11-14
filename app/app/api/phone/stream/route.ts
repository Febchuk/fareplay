import { deviceId, phoneuse, PHONEUSE_API, token } from "@/lib/phoneuse";

export const dynamic = "force-dynamic";

const BOUNDARY = "frame";

export async function GET(req: Request) {
  const device = await deviceId();
  await phoneuse("POST", `/api/devices/${device}/view`);
  const ws = new WebSocket(`${PHONEUSE_API.replace("http", "ws")}/api/devices/${device}/stream`);
  ws.binaryType = "arraybuffer";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      ws.onopen = () => ws.send(JSON.stringify({ token: token(), keepalive: true }));
      let last = 0;
      ws.onmessage = (msg) => {
        if (typeof msg.data === "string" || Date.now() - last < 120) return;
        last = Date.now();
        const jpeg = new Uint8Array(msg.data as ArrayBuffer);
        controller.enqueue(encoder.encode(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.byteLength}\r\n\r\n`));
        controller.enqueue(jpeg);
        controller.enqueue(encoder.encode("\r\n"));
      };
      ws.onclose = () => controller.close();
      ws.onerror = () => controller.close();
      req.signal.addEventListener("abort", () => ws.close());
    },
    cancel() {
      ws.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`, "Cache-Control": "no-cache, no-store" },
  });
}
