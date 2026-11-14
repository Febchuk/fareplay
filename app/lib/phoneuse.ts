import { readFileSync } from "node:fs";
import path from "node:path";

export const PHONEUSE_API = "http://127.0.0.1:8765";

export function token() {
  return readFileSync(path.resolve(process.cwd(), "../../platform/.state/admin-token"), "utf8").trim();
}

export async function phoneuse<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(PHONEUSE_API + route, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${route} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function deviceId() {
  const { devices } = await phoneuse<{ devices: { id: string; online: boolean }[] }>("GET", "/api/devices");
  const device = devices.find((d) => d.online) ?? devices[0];
  if (!device) throw new Error("No iPhone connected");
  return device.id;
}
