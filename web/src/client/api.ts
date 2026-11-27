import type { BoardState } from "../shared/api";
import type { Lines } from "../shared/screen";
import { refreshViewer } from "./auth";

/** Parses a response from our own API, whose shape the Worker guarantees. */
async function json<T>(res: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await (await check(res)).json()) as T;
}

async function check(res: Response): Promise<Response> {
  // Signed out elsewhere, or the session ran out: back to signing in.
  if (res.status === 401) {
    refreshViewer();
  }
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

/** True until the first account exists. */
export async function fetchSetupNeeded(): Promise<boolean> {
  return (await json<{ needed: boolean }>(await fetch("/api/setup"))).needed;
}

/**
 * Creates the first account, an admin, with the deploy's SETUP_PASSWORD.
 * False if an account already exists.
 */
export async function createFirstAccount(account: {
  setupPassword: string;
  name: string;
  email: string;
  password: string;
}): Promise<boolean> {
  const res = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  if (res.status === 409) {
    return false;
  }
  await check(res);
  return true;
}
