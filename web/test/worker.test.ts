import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BoardState } from "../src/shared/api";
import { getFont } from "../src/shared/font";
import { renderScreen } from "../src/shared/render";
import { SCREEN_BYTES } from "../src/shared/screen";
import worker from "../src/worker/index";

const LEFT = "E6614103E71F8D26";
const AUTH = { Authorization: `Basic ${btoa("admin:secret")}` };

function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`http://api.hymnboard.sonrise.io${path}`, { headers }));
}

function putLines(lines: string[], headers: Record<string, string> = AUTH) {
  return exports.default.fetch(
    new Request("http://api.hymnboard.sonrise.io/api/lines", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
    }),
  );
}

let pings: { url: string; body: string }[];

beforeEach(() => {
  pings = [];
  // Healthcheck pings are the only outbound requests.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    pings.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return Promise.resolve(new Response(null, { status: 200 }));
  });
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
  test("records boots, health and image fetches", async () => {
    expect(
      (await get(`/device_booted?device_id=${LEFT}&saved_state_writes=3&watchdog_caused_reboot=1`))
        .status,
    ).toBe(204);
    expect((await get(`/device_healthy?device_id=${LEFT}&saved_state_writes=4`)).status).toBe(204);
    await get(`/images/3?device_id=${LEFT}&saved_state_writes=4`);
    await get("/device_healthy?device_id=E661A4D41787452B");

    await settle();
    expect(pings.map((p) => p.url.split("hc-ping.com/")[1])).toEqual([
      "a717c5f0-8a83-45f9-92a7-c79a21a437b4/failure",
      "a717c5f0-8a83-45f9-92a7-c79a21a437b4",
      "a717c5f0-8a83-45f9-92a7-c79a21a437b4/log",
      "6c7ef2cb-71b8-492e-9e11-4ddfacf29d0c",
    ]);

    const state = await (await get("/api/state", AUTH)).json<BoardState>();
    expect(state.devices.map((d) => d.name)).toEqual(["Left Hymn Board", "Right Hymn Board"]);
    const left = state.devices[0]!;
    expect(left.saved_state_writes).toBe(4);
    expect(left.booted_at).toBeTruthy();
    expect(left.last_updated_at).toBeTruthy();
    expect(state.devices[1]!.booted_at).toBeNull();
  });

  test("pings healthchecks.io only where HEALTHCHECKS is on", async () => {
    // A Cloudflare deploy has no HEALTHCHECKS var, unlike the self-hosted image.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://api.hymnboard.sonrise.io/device_booted?device_id=${LEFT}`),
      { ...env, HEALTHCHECKS: undefined },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(pings).toEqual([]);
  });

  test("ignores a saved_state_writes that isn't an integer", async () => {
    await get(`/device_healthy?device_id=${LEFT}&saved_state_writes=9`);
    await get(`/device_healthy?device_id=${LEFT}&saved_state_writes=lots`);
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

  test("requires basic auth", async () => {
    expect((await get("/api/state")).status).toBe(401);
    expect(
      (await get("/api/state", { Authorization: `Basic ${btoa("admin:wrong")}` })).status,
    ).toBe(401);
    expect((await putLines(["1", "2", "3", "4", "5", "6"], {})).status).toBe(401);
  });

  test("rejects anything but six strings", async () => {
    expect((await putLines(["1", "2"])).status).toBe(400);
    for (const body of ["null", "[]", "not json", '"lines"']) {
      const res = await exports.default.fetch(
        new Request("http://api.hymnboard.sonrise.io/api/lines", {
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
    new Request("http://api.hymnboard.sonrise.io/firmware", {
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
