import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BoardState, HealthSample } from "../src/shared/api";
import { getFont } from "../src/shared/font";
import { renderScreen } from "../src/shared/render";
import { SCREEN_BYTES } from "../src/shared/screen";
import { type Ping, recordPings } from "./healthchecks";
import { signInAsAdmin } from "./signIn";
import worker from "../src/worker/index";

const LEFT = "E6614103E71F8D26";
/** The session cookie of the first account, an admin. */
let AUTH: Record<string, string>;

beforeAll(async () => {
  AUTH = await signInAsAdmin();
});

function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`https://hymnboard.sonrise.io${path}`, { headers }));
}

function putLines(lines: string[], headers?: Record<string, string>) {
  return exports.default.fetch(
    new Request("https://hymnboard.sonrise.io/api/lines", {
      method: "PUT",
      headers: { ...(headers ?? AUTH), "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    }),
  );
}

let pings: Ping[];

beforeEach(() => {
  pings = recordPings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** waitUntil'd pings finish after the response; give them a tick. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("GET /ok", async () => {
  expect((await get("/ok")).status).toBe(204);
});

describe("GET /images/:id (device protocol)", () => {
  test("serves the raw 1-bit buffer with a bare SHA-1 Etag", async () => {
    const res = await get(
      `/images/1?device_id=${LEFT}&saved_state_writes=7&watchdog_caused_reboot=0`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Etag")).toMatch(/^[0-9a-f]{40}$/);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(SCREEN_BYTES);
    expect(body.every((byte) => byte === 0)).toBe(true);

    await settle();
    expect(pings).toEqual([
      {
        url: "https://hc-ping.com/a717c5f0-8a83-45f9-92a7-c79a21a437b4/log",
        body: "Updating image 1",
      },
    ]);
  });

  test("answers 304 for a current ?etag= or If-None-Match", async () => {
    const etag = (await get("/images/2")).headers.get("Etag")!;

    const byQuery = await get(`/images/2?device_id=${LEFT}&etag=${etag}`);
    expect(byQuery.status).toBe(304);
    expect(byQuery.headers.get("Etag")).toBe(etag);

    expect((await get("/images/2", { "If-None-Match": etag })).status).toBe(304);
  });

  test("404s for screens that don't exist", async () => {
    expect((await get("/images/0")).status).toBe(404);
    expect((await get("/images/4")).status).toBe(404);
  });

  test("serves new lines rendered by the shared rasterizer", async () => {
    const oldEtag = (await get("/images/1")).headers.get("Etag")!;

    expect((await putLines(["657", "LSB 657", "", "", "", ""])).status).toBe(200);

    const res = await get(`/images/1?etag=${oldEtag}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Etag")).not.toBe(oldEtag);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      renderScreen(getFont(), "657", "LSB 657"),
    );
  });
});

describe("device status", () => {
  test("records boots and image fetches", async () => {
    expect(
      (await get(`/device_booted?device_id=${LEFT}&saved_state_writes=3&watchdog_caused_reboot=1`))
        .status,
    ).toBe(204);
    await get(`/images/3?device_id=${LEFT}&saved_state_writes=4`);
    await get("/images/2?device_id=E661A4D41787452B");

    await settle();
    expect(pings.map((p) => p.url.split("hc-ping.com/")[1])).toEqual([
      "a717c5f0-8a83-45f9-92a7-c79a21a437b4/failure",
      "a717c5f0-8a83-45f9-92a7-c79a21a437b4/log",
      "6c7ef2cb-71b8-492e-9e11-4ddfacf29d0c/log",
    ]);

    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    expect(state.devices.map((d) => d.name)).toEqual(["Left Hymn Board", "Right Hymn Board"]);
    const left = state.devices[0]!;
    expect(left.saved_state_writes).toBe(4);
    expect(left.booted_at).toBeTruthy();
    expect(left.last_updated_at).toBeTruthy();
    expect(state.devices[1]!.booted_at).toBeNull();
  });

  // Previews have no HEALTHCHECKS var and `pnpm dev` has it off, unlike
  // production (and these tests' default, vitest.config.ts).
  test.each([undefined, "", "off", "true"])(
    "pings nothing when HEALTHCHECKS is %j",
    async (healthchecks) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://hymnboard.sonrise.io/device_booted?device_id=${LEFT}`),
        { ...env, HEALTHCHECKS: healthchecks },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(204);
      expect(pings).toEqual([]);
    },
  );

  test("ignores a saved_state_writes that isn't an integer", async () => {
    await get(`/images/1?device_id=${LEFT}&saved_state_writes=9`);
    await get(`/images/1?device_id=${LEFT}&saved_state_writes=lots`);
    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    expect(state.devices[0]!.saved_state_writes).toBe(9);
  });

  test("OTA results replace the watchdog failure ping", async () => {
    await get(
      `/device_booted?device_id=${LEFT}&watchdog_caused_reboot=1&firmware_version=v2&ota_status=updated&ota_version=v2`,
    );
    await settle();
    expect(pings.map((p) => p.body)).toEqual(["Installed firmware v2"]);
  });

  test("an OTA status without a valid version is an ordinary boot", async () => {
    const right = "E661A4D41787452B";
    await get(`/device_booted?device_id=${right}&watchdog_caused_reboot=1&ota_status=updated`);
    await get(`/device_booted?device_id=${right}&ota_status=rolled_back&ota_version=bad%20version`);
    await settle();
    expect(pings.map((p) => p.body)).toEqual(["Watchdog caused reboot", "Device booted"]);
    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    expect(state.devices.find((d) => d.id === right)!.ota_status).toBeNull();
  });
});

const STUCK = 3;

function poll(etag = "") {
  return get(`/images/2?device_id=${LEFT}&etag=${etag}`);
}

async function stuckAt() {
  return (await (await get("/api/state", AUTH)).json<BoardState>()).devices[0]!.etag_stuck_at;
}

function failures() {
  return pings.filter((p) => p.url.endsWith("/failure")).map((p) => p.body);
}

describe("boards that don't keep their ETag", () => {
  test("are flagged once after three identical downloads, and cleared by a 304", async () => {
    const etag = (await poll()).headers.get("Etag")!;
    await poll();
    await settle();
    expect(failures()).toEqual([]);
    expect(await stuckAt()).toBeNull();

    await poll();
    await poll();
    await settle();
    expect(failures()).toEqual([
      "Board isn't keeping its ETag: downloaded image 2 3 times in a row",
    ]);
    expect(await stuckAt()).toBeTruthy();

    expect((await poll(etag)).status).toBe(304);
    expect(await stuckAt()).toBeNull();
  });

  test("aren't flagged for downloading each new image once", async () => {
    for (const line of ["1", "2", "3"]) {
      await putLines(["", "", line, "", "", ""]);
      const etag = (await poll()).headers.get("Etag")!;
      expect((await poll(etag)).status).toBe(304);
    }
    await settle();
    expect(failures()).toEqual([]);
    expect(await stuckAt()).toBeNull();
  });

  test("stay flagged through a new image until the stuck screen gets a 304", async () => {
    for (let i = 0; i < STUCK; i++) await poll();
    await settle();
    expect(failures()).toHaveLength(1);

    // A new image for the stuck screen, and a 304 for another one.
    await putLines(["", "", "new", "", "", ""]);
    const etag = (await poll()).headers.get("Etag")!;
    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    const screen1 = state.screens.find((s) => s.id === 1)!.etag;
    expect((await get(`/images/1?device_id=${LEFT}&etag=${screen1}`)).status).toBe(304);
    await poll();
    await settle();
    expect(await stuckAt()).toBeTruthy();
    expect(failures()).toHaveLength(1);

    expect((await poll(etag)).status).toBe(304);
    expect(await stuckAt()).toBeNull();
  });
});

describe("admin API", () => {
  test("refuses changes from other sites", async () => {
    const crossSite = { ...AUTH, "Sec-Fetch-Site": "cross-site" };
    expect((await putLines(["1", "2", "3", "4", "5", "6"], crossSite)).status).toBe(403);
    expect((await upload("v9", 512, { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    // Past the check: an invalid version is the next thing refused.
    expect((await upload("bad version!", 512, { "Sec-Fetch-Site": "same-origin" })).status).toBe(
      400,
    );
    // Reading and navigating from another site still work.
    expect((await get("/api/state", crossSite)).status).toBe(200);
  });

  test("requires signing in", async () => {
    expect((await get("/api/state")).status).toBe(401);
    expect(
      (await get("/api/state", { Cookie: "__Secure-better-auth.session_token=forged" })).status,
    ).toBe(401);
    expect((await putLines(["1", "2", "3", "4", "5", "6"], {})).status).toBe(401);
    expect((await get("/api/screens/1")).status).toBe(401);
  });

  test("rejects anything but six strings", async () => {
    expect((await putLines(["1", "2"])).status).toBe(400);
    const long = await putLines(["x".repeat(101), "", "", "", "", ""]);
    expect(long.status).toBe(400);
    expect(await long.text()).toBe("Each line is at most 100 characters\n");
    for (const body of ["null", "[]", "not json", '"lines"']) {
      const res = await exports.default.fetch(
        new Request("https://hymnboard.sonrise.io/api/lines", {
          method: "PUT",
          headers: { ...AUTH, "Content-Type": "application/json" },
          body,
        }),
      );
      expect(res.status, body).toBe(400);
    }
  });

  test("saves trimmed lines and serves the stored screen bits", async () => {
    const res = await putLines([" 123 ", "", "", "", "", "Kyrie"]);
    const state = await res.json<BoardState>();
    expect(state.lines).toEqual(["123", "", "", "", "", "Kyrie"]);
    expect(state.screens.map((s) => s.id)).toEqual([1, 2, 3]);

    const screen = await get("/api/screens/3", AUTH);
    expect(new Uint8Array(await screen.arrayBuffer())).toEqual(
      renderScreen(getFont(), "", "Kyrie"),
    );
  });
});

function upload(version: string, size: number, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("version", version);
  form.set("image", new File([new Uint8Array(size).fill(7)], "fw.bin"));
  return exports.default.fetch(
    new Request("https://hymnboard.sonrise.io/firmware", {
      method: "POST",
      headers: { ...AUTH, ...headers },
      body: form,
    }),
  );
}

describe("OTA firmware", () => {
  test("validates uploads", async () => {
    expect((await upload("bad version!", 512)).status).toBe(400);
    expect((await upload("v1", 100)).status).toBe(400);
    expect((await upload("v1", 0)).status).toBe(400);
    expect((await upload("v1", 1001 * 1024)).status).toBe(400);
  });

  test("offers the uploaded version to boards running another one", async () => {
    expect((await get("/firmware/latest?device_id=X&version=v1")).status).toBe(204);
    expect((await upload("v2", 512)).status).toBe(201);

    const latest = await get(`/firmware/latest?device_id=${LEFT}&version=v1`);
    expect(latest.status).toBe(200);
    expect(await latest.text()).toBe("v2");
    expect((await get(`/firmware/latest?device_id=${LEFT}&version=v2`)).status).toBe(204);

    expect((await get("/firmware/image?target_version=v1")).status).toBe(409);
    const image = await get(`/firmware/image?device_id=${LEFT}&target_version=v2`);
    expect(image.status).toBe(200);
    expect((await image.arrayBuffer()).byteLength).toBe(512);
  });
});

describe("diagnostics", () => {
  test("a boot says why the board reset, for the admin and healthchecks.io", async () => {
    const res = await get(
      `/device_booted?device_id=${LEFT}&saved_state_writes=3&watchdog_caused_reboot=1` +
        "&reset=crash&reset_phase=running&reset_detail=268440116&reset_extra=268457593&reset_uptime=3600&uptime=4&rssi=-70",
    );
    expect(res.status).toBe(204);
    await settle();
    expect(pings.at(-1)?.body).toBe(
      "Watchdog caused reboot (reset: crash while running after 3600 s at 0x10001234 from 0x10005679)",
    );
    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    const left = state.devices.find((d) => d.id === LEFT);
    expect(left).toMatchObject({
      rssi: -70,
      uptime_s: 4,
      last_reset: {
        reason: "crash",
        phase: "running",
        detail: 268440116,
        extra: 268457593,
        uptime_s: 3600,
      },
    });
    expect(left?.last_reset?.at).toBe(left?.booted_at);
  });

  test("the hourly version check carries the board's health, kept as history", async () => {
    await get(`/firmware/latest?device_id=${LEFT}&version=v1`);
    await get(
      `/firmware/latest?device_id=${LEFT}&version=v1&uptime=3600&rssi=-66&heap_free=90000&heap_min=45000` +
        "&drops=2&connect_fails=3&pong_timeouts=1&image_fails=0&wifi_drops=0&tls_oom=0",
    );

    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    expect(state.devices.find((d) => d.id === LEFT)).toMatchObject({
      firmware_version: "v1",
      rssi: -66,
      uptime_s: 3600,
      health: { heap_free: 90000, heap_min: 45000, drops: 2, connect_fails: 3 },
    });
    // The first check, from firmware without diagnostics, added no history
    const history = await (await get(`/api/devices/${LEFT}/health`, AUTH)).json<HealthSample[]>();
    expect(history.map(({ at, ...sample }) => [Date.parse(at) > 0, sample])).toEqual([
      [true, { rssi: -66, uptime_s: 3600, heap_min: 45000 }],
    ]);
    expect((await get(`/api/devices/${LEFT}/health`)).status).toBe(401);
  });

  test("an unknown board's health isn't kept", async () => {
    await get("/firmware/latest?device_id=X&version=v1&uptime=3600&rssi=-66&heap_free=90000");
    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    expect(state.devices.find((d) => d.id === "X")).toMatchObject({
      firmware_version: "v1",
      rssi: null,
      health: null,
    });
    const history = await (await get("/api/devices/X/health", AUTH)).json<HealthSample[]>();
    expect(history).toEqual([]);
  });
});
