import type { BoardState } from "../shared/api";
import type { Lines } from "../shared/screen";

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res;
}

export async function fetchState(): Promise<BoardState> {
  return (await check(await fetch("/api/state"))).json();
}

export async function saveLines(lines: Lines): Promise<BoardState> {
  const res = await fetch("/api/lines", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines }),
  });
  return (await check(res)).json();
}

/** The bits a board downloads for this screen. */
export async function fetchScreen(id: number): Promise<Uint8Array> {
  return new Uint8Array(await (await check(await fetch(`/api/screens/${id}`))).arrayBuffer());
}
