import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BoardState } from "../src/shared/api";
import {
  CLOSE_REPLACED,
  CLOSE_SILENT,
  HEALTH_INTERVAL_MS,
  SOCKET_SILENT_MS,
} from "../src/worker/hymn-board";
import { type Ping, recordPings } from "./healthchecks";

const LEFT = "E6614103E71F8D26";
const RIGHT = "E661A4D41787452B";
const LEFT_PING = "https://hc-ping.com/a717c5f0-8a83-45f9-92a7-c79a21a437b4";
const AUTH = { Authorization: `Basic ${btoa("admin:secret")}` };
const BASE = "http://api.hymnboard.sonrise.io";
const STATE = /^state 1 ([0-9a-f]{40}) ([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/;

/** A board's end of its WebSocket, collecting what the server sends. */
class Board {
  readonly messages: string[] = [];
  readonly closed: Promise<CloseEvent>;
  readonly #waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      this.messages.push(String(event.data));
      this.#waiters.splice(0).forEach((wake) => wake());
    });
    this.closed = new Promise((resolve) => ws.addEventListener("close", resolve));
  }

  /** Resolves with the next message after the `seen` already received. */
  async next(seen = this.messages.length): Promise<string> {
    while (this.messages.length <= seen) {
      await new Promise<void>((wake) => this.#waiters.push(wake));
    }
    return this.messages[seen]!;
  }

  /** Sends a message and waits for the server's next one. */
  async ask(message: string): Promise<string> {
    const seen = this.messages.length;
    this.ws.send(message);
    return this.next(seen);
  }
}

const sockets: Board[] = [];

function upgrade(query: string, headers: Record<string, string> = { Upgrade: "websocket" }) {
  return exports.default.fetch(new Request(`${BASE}/ws?${query}`, { headers }));
}

/** Connects as the firmware does, with its query string. */
async function connect(deviceId = LEFT, firmware = "v1"): Promise<Board> {
  const res = await upgrade(
    `device_id=${deviceId}&saved_state_writes=4&watchdog_caused_reboot=0&firmware_version=${firmware}&proto=1`,
  );
  expect(res.status).toBe(101);
  const board = new Board(res.webSocket!);
  sockets.push(board);
  return board;
}

async function state(): Promise<BoardState> {
  const res = await exports.default.fetch(new Request(`${BASE}/api/state`, { headers: AUTH }));
  return res.json();
}

function device(s: BoardState, id = LEFT) {
  return s.devices.find((d) => d.id === id);
}

let pings: Ping[];

beforeEach(() => {
  pings = recordPings();
});

afterEach(async () => {
  for (const board of sockets.splice(0)) {
    if (board.ws.readyState === WebSocket.OPEN) {
      board.ws.close(1000, "test over");
      await board.closed;
    }
  }
  vi.restoreAllMocks();
});

/** As if the board connected long ago and its pings were never recorded. */
async function makeSilent() {
  await runInDurableObject(env.HYMN_BOARD.getByName("main"), (_, ctx) => {
    for (const ws of ctx.getWebSockets(LEFT)) {
      ws.serializeAttachment({ deviceId: LEFT, connectedAt: Date.now() - SOCKET_SILENT_MS });
    }
  });
}

/** Lets the object's waitUntil'd work (healthcheck pings) finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The board hangs up, and the server has dealt with it. */
async function hangUp(board: Board) {
  board.ws.close(1000, "bye");
  await board.closed;
  await settle();
}

/** The next alarm pings nobody and schedules no other. */
async function expectAlarmToStop() {
  const stub = env.HYMN_BOARD.getByName("main");
  pings.length = 0;
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(pings).toEqual([]);
  expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm())).toBeNull();
}

describe("GET /ws", () => {
  test("needs an upgrade and a known board", async () => {
    expect((await upgrade(`device_id=${LEFT}`, {})).status).toBe(426);
    expect((await upgrade("device_id=2222222222222222")).status).toBe(403);
    expect((await upgrade("device_id=")).status).toBe(403);
    expect((await upgrade("saved_state_writes=1")).status).toBe(403);
    expect((await upgrade("device_id=__proto__")).status).toBe(403);
  });

  test("sends the board its state when it connects", async () => {
    const board = await connect();
    const message = await board.next(0);
    const match = STATE.exec(message);
    expect(match).not.toBeNull();
    const etags = await Promise.all(
      [1, 2, 3].map(async (id) =>
        (await exports.default.fetch(`${BASE}/images/${id}`)).headers.get("Etag"),
      ),
    );
    expect(match!.slice(1, 4)).toEqual(etags);
    expect(match![4]).toBe("-"); // no firmware uploaded

    const s = await state();
    expect(device(s)).toMatchObject({
      live: true,
      firmware_version: "v1",
      saved_state_writes: 4,
      disconnected_at: null,
    });
    expect(device(s)?.connected_at).toBeTruthy();
    await settle();
    expect(pings).toContainEqual({ url: LEFT_PING, body: "Socket connected" });
  });

  test("answers ping with pong, and counts it as seeing the board", async () => {
    const board = await connect();
    await board.next(0);
    const before = device(await state())!.last_seen!;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await board.ask("ping")).toBe("pong");
    expect(Date.parse(device(await state())!.last_seen!)).toBeGreaterThan(Date.parse(before));
  });

  test("pushes new screens to every board when the lines change", async () => {
    const left = await connect(LEFT);
    const right = await connect(RIGHT);
    const [first] = await Promise.all([left.next(0), right.next(0)]);

    const res = await exports.default.fetch(
      new Request(`${BASE}/api/lines`, {
        method: "PUT",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ lines: ["123", "", "", "", "", "456"] }),
      }),
    );
    expect(res.status).toBe(200);
    const pushed = await Promise.all([left.next(1), right.next(1)]);
    expect(pushed[0]).toBe(pushed[1]);
    expect(pushed[0]).not.toBe(first);

    const etags = STATE.exec(pushed[0])!.slice(1, 4);
    const screens = (await res.json<BoardState>()).screens.map((s) => s.etag);
    expect(etags).toEqual(screens);
    // Screen 2 is blank either way, so only 1 and 3 changed
    expect(etags[1]).toBe(STATE.exec(first)![2]);
  });

  test("pushes an uploaded firmware version", async () => {
    const board = await connect();
    await board.next(0);
    const form = new FormData();
    form.set("version", "v2");
    form.set("image", new File([new Uint8Array(512)], "fw.bin"));
    const res = await exports.default.fetch(
      new Request(`${BASE}/firmware`, { method: "POST", headers: AUTH, body: form }),
    );
    expect(res.status).toBe(201);
    expect(STATE.exec(await board.next(1))![4]).toBe("v2");
  });

  test("records what the board shows", async () => {
    const board = await connect();
    const etags = STATE.exec(await board.next(0))!.slice(1, 4);
    board.ws.send(`shown ${etags.join(" ")}`);
    // A ping round trip orders it after the message
    await board.ask("ping");
    await runInDurableObject(env.HYMN_BOARD.getByName("main"), () => undefined);
    expect(JSON.parse(device(await state())!.shown_etags!)).toEqual(etags);
  });

  test("takes any etag the firmware counts as safe", async () => {
    const board = await connect();
    await board.next(0);
    board.ws.send("shown a.b c_d -");
    await board.ask("ping");
    await runInDurableObject(env.HYMN_BOARD.getByName("main"), () => undefined);
    expect(JSON.parse(device(await state())!.shown_etags!)).toEqual(["a.b", "c_d", "-"]);
  });

  test("a newer socket from the same board replaces the old one", async () => {
    const old = await connect();
    await old.next(0);
    const before = device(await state())!.disconnected_at;
    pings.length = 0;
    const replacement = await connect();
    await replacement.next(0);

    const closed = await old.closed;
    expect(closed.code).toBe(CLOSE_REPLACED);
    expect(await replacement.ask("ping")).toBe("pong");
    await settle();
    const s = await state();
    expect(device(s)!.live).toBe(true);
    // Not a disconnect: the board never went away
    expect(device(s)!.disconnected_at).toBe(before);
    expect(pings.filter((p) => p.url.endsWith("/log"))).toEqual([]);
  });

  test("a replaced socket whose board never answers the close doesn't count", async () => {
    // A board that lost power: its old socket never echoes the server's
    // close, so it stays listed as closing.
    const gone = await upgrade(
      `device_id=${LEFT}&saved_state_writes=4&watchdog_caused_reboot=0&firmware_version=v1&proto=1`,
    );
    expect(gone.status).toBe(101);
    const rebooted = await connect();
    await rebooted.next(0);
    await hangUp(rebooted);

    expect(device(await state())?.live).toBe(false);
    await expectAlarmToStop();
  });

  test("a closed socket shows the board offline and logs it", async () => {
    const board = await connect();
    await board.next(0);
    await hangUp(board);

    const s = await state();
    expect(device(s)?.live).toBe(false);
    expect(device(s)?.disconnected_at).toBeTruthy();
    expect(pings).toContainEqual({
      url: `${LEFT_PING}/log`,
      body: "Socket closed (code 1000, bye)",
    });
  });

  test("the alarm closes a socket that neither pings nor answers the state, and logs it once", async () => {
    const board = await connect();
    await board.next(0);
    const stub = env.HYMN_BOARD.getByName("main");
    await makeSilent();

    // The first run sends the state, and still counts the board live
    pings.length = 0;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(STATE.test(await board.next(1))).toBe(true);
    expect(pings).toEqual([{ url: LEFT_PING, body: "Socket live" }]);

    // Unanswered by the next run: closed, and recorded at once, since a
    // board that's gone never answers the close
    pings.length = 0;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const s = await state();
    expect(device(s)?.live).toBe(false);
    expect(device(s)?.disconnected_at).toBeTruthy();
    expect(pings).toEqual([{ url: `${LEFT_PING}/log`, body: "Socket closed (no ping)" }]);

    // One that's still there answers it, and that isn't logged again
    expect((await board.closed).code).toBe(CLOSE_SILENT);
    await settle();
    expect(pings).toHaveLength(1);
  });

  // On Cloudflare, a deploy stops the auto-response's timestamp for sockets
  // from before it, though their pings are still answered
  test("a board whose pings went unrecorded stays live while it answers the state", async () => {
    const board = await connect();
    await board.next(0);
    const stub = env.HYMN_BOARD.getByName("main");
    await makeSilent();
    expect(device(await state())?.live).toBe(false);

    for (let run = 0; run < 3; run++) {
      pings.length = 0;
      const seen = board.messages.length;
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(pings).toEqual([{ url: LEFT_PING, body: "Socket live" }]);
      // The firmware answers every state message with what it shows
      expect(STATE.test(await board.next(seen))).toBe(true);
      board.ws.send("shown a b c");
      await settle();
      expect(device(await state())?.live).toBe(true);
    }
    expect(board.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("the alarm pings healthchecks.io for each live board and reschedules", async () => {
    const board = await connect();
    await board.next(0);
    const stub = env.HYMN_BOARD.getByName("main");
    const scheduled = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
    expect(scheduled).toBeGreaterThan(Date.now() + HEALTH_INTERVAL_MS - 60_000);

    pings.length = 0;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pings).toEqual([{ url: LEFT_PING, body: "Socket live" }]);
    expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm())).not.toBeNull();
  });

  test("the alarm stops once no board is connected", async () => {
    const board = await connect();
    await board.next(0);
    await hangUp(board);
    await expectAlarmToStop();
  });
});

test("EXTRA_DEVICE_IDS lets a test board connect", async () => {
  const board = await connect("1111111111111111");
  expect(STATE.test(await board.next(0))).toBe(true);
  expect(device(await state(), "1111111111111111")?.live).toBe(true);
});
