import type { BoardState, HealthSample } from "../shared/api";
import type { Lines } from "../shared/screen";

/** Parses a response from our own API, whose shape the Worker guarantees. */
async function json<T>(res: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await (await check(res)).json()) as T;
}

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res;
}

export async function fetchState(): Promise<BoardState> {
  return json<BoardState>(await fetch("/api/state"));
}

export async function saveLines(lines: Lines): Promise<BoardState> {
  const res = await fetch("/api/lines", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  });
  return json<BoardState>(res);
}

/** The bits a board downloads for this screen, and their ETag. */
export async function fetchScreen(id: number): Promise<{ etag: string; buffer: Uint8Array }> {
  const res = await check(await fetch(`/api/screens/${id}`));
  return { etag: res.headers.get("Etag") ?? "", buffer: new Uint8Array(await res.arrayBuffer()) };
}

/** A board's hourly health reports from the last week, oldest first. */
export async function fetchHealthHistory(deviceId: string): Promise<HealthSample[]> {
  return json<HealthSample[]>(await fetch(`/api/devices/${encodeURIComponent(deviceId)}/health`));
}

/** Asks a connected board for a fresh health report; the state then has it. */
export async function refreshDiagnostics(deviceId: string): Promise<BoardState> {
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics`, {
    method: "POST",
  });
  return json<BoardState>(res);
}
