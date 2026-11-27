import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { BoardState, DeviceStatusParams, Viewer } from "../shared/api";
import { EMPTY_LINES, isLines, SCREEN_COUNT, trimLines } from "../shared/screen";
import {
  DEVICE_NAMES,
  deviceSortIndex,
  getDeviceName,
  healthchecksOn,
  pingHealthcheck,
} from "./devices";

import { STUCK_ETAG_DOWNLOADS } from "./hymn-board";
import * as accounts from "./accounts";

export { HymnBoard } from "./hymn-board";

// Must match the device: OTA images are written to flash in 256-byte pages,
// the download slot is 1000 KB, and versions are at most 47 characters.
const FIRMWARE_PAGE_SIZE = 256;
const FIRMWARE_MAX_SIZE = 1000 * 1024;
const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,47}$/;

const MAX_LINE_LENGTH = 100;

type AppEnv = { Bindings: Env; Variables: { viewer: Viewer } };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

/** Both boards share one HymnBoard instance. */
function board(env: Env) {
  return env.HYMN_BOARD.getByName("main");
}

/**
 * A browser sends its cookies with a cross-site form post too, so changes
 * must come from the admin page itself (or from a tool like curl, which sends
 * no Sec-Fetch-Site). Better Auth checks the Origin of its own as well.
 */
app.use("*", async (c, next) => {
  const site = c.req.header("Sec-Fetch-Site");
  const changes = c.req.method !== "GET" && c.req.method !== "HEAD";
  if (changes && (site === "cross-site" || site === "same-site")) {
    return c.text("Cross-site request refused\n", 403);
  }
  return next();
});

/**
 * Who's asking: the account of an API key, for scripts and workflows (in
 * X-Api-Key, or Authorization: Bearer), or else whoever's signed in. A key
 * acts as its account, with its role, but only on the routes below: never
 * on Better Auth's own, so it can't manage accounts or keys.
 */
async function authenticate(c: AppContext): Promise<Viewer | Response> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
  // `||`, not `??`: an empty X-Api-Key (an unset variable in a script) mustn't
  // hide the key in Authorization.
  const key = c.req.header("X-Api-Key") || bearer;
  const viewer = key
    ? await accounts.apiKeyViewer(c.env, c.req.raw, key)
    : await accounts.viewer(c.env, c.req.raw);
  return viewer ?? c.text(key ? "Invalid API key\n" : "Sign in first\n", 401);
}

/** The lines and screens: any account. */
const requireViewer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const viewer = await authenticate(c);
  if (viewer instanceof Response) {
    return viewer;
  }
  c.set("viewer", viewer);
  return next();
};

/** Firmware: admins only (device/README.md uploads it with curl and a key). */
const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const viewer = await authenticate(c);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (viewer.role !== "admin") {
    return c.text("Only admins can do that\n", 403);
  }
  c.set("viewer", viewer);
  return next();
};

function deviceStatus(c: AppContext): DeviceStatusParams {
  return {
    device_id: c.req.query("device_id") || undefined,
    saved_state_writes: parseInteger(c.req.query("saved_state_writes")),
  };
}

/** Like Flask's request.args.get(..., type=int): undefined unless an integer. */
function parseInteger(value: string | undefined): number | undefined {
  return value !== undefined && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : undefined;
}

/**
 * Runs a healthchecks.io ping after the response is sent, when this server is
 * the one the boards' checks belong to (HEALTHCHECKS=on).
 */
function ping(c: AppContext, ...args: Parameters<typeof pingHealthcheck>) {
  if (!healthchecksOn(c.env)) {
    return;
  }
  c.executionCtx.waitUntil(pingHealthcheck(...args));
}

// ---------------------------------------------------------------------------
// Device endpoints. The firmware hard-codes these paths, the query parameters
// and the response bytes, so they must not change.
// ---------------------------------------------------------------------------

app.get("/ok", (c) => c.body(null, 204));

// The board's WebSocket: the server pushes its state (screen etags and
// firmware version) here, so it no longer polls. Images still come from
// /images/N. Only the known boards may connect.
app.get("/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected a WebSocket upgrade\n", 426);
  }
  const deviceId = c.req.query("device_id");
  const extra = (c.env.EXTRA_DEVICE_IDS ?? "").split(",").map((id) => id.trim());
  const known = deviceId && (Object.hasOwn(DEVICE_NAMES, deviceId) || extra.includes(deviceId));
  if (!known) {
    console.log(`Refusing a socket from unknown device ${deviceId}`);
    return c.text("Unknown device\n", 403);
  }
  return board(c.env).fetch(c.req.raw);
});

app.get("/images/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  if (id < 1 || id > SCREEN_COUNT) {
    return c.notFound();
  }

  // The firmware's HTTP client can't send headers, so it passes ?etag=.
  const etag = c.req.header("If-None-Match") || c.req.query("etag") || undefined;
  const status = deviceStatus(c);
  // Sent by a board redrawing its screens (the "redraw" message): it wants
  // the image even if its etag is current
  const redraw = c.req.query("redraw") === "1";
  const result = await board(c.env).fetchImage(id, etag, status, redraw);

  // The firmware stores this bare 40-character value, so no quotes.
  c.header("Etag", result.etag);

  if (result.status === 304) {
    return c.body(null, 304);
  }

  if (result.redraw) {
    console.log(
      `Device ${getDeviceName(status.device_id)} (${status.device_id}) redrawing image ${id} (${result.etag})`,
    );
  } else {
    console.log(
      `Device ${getDeviceName(status.device_id)} (${status.device_id}) updating image ${id} from ${etag} to ${result.etag}`,
    );
    ping(c, status.device_id, "/log", `Updating image ${id}`);
  }

  if (result.etagStuck) {
    console.log(
      `Warning: Device ${getDeviceName(status.device_id)} (${status.device_id}) downloaded image ${id} ${STUCK_ETAG_DOWNLOADS} times in a row without keeping its ETag`,
    );
    ping(
      c,
      status.device_id,
      "/failure",
      `Board isn't keeping its ETag: downloaded image ${id} ${STUCK_ETAG_DOWNLOADS} times in a row`,
    );
  }

  return c.body(result.buffer, 200, { "Content-Type": "application/octet-stream" });
});

app.get("/device_booted", async (c) => {
  const { device_id, saved_state_writes } = deviceStatus(c);
  const watchdogCausedReboot = c.req.query("watchdog_caused_reboot") === "1";
  const firmwareVersion = c.req.query("firmware_version");
  let otaStatus = c.req.query("ota_status");
  let otaVersion = c.req.query("ota_version");
  let otaAt: string | undefined;
  const name = getDeviceName(device_id);

  // An OTA report needs a valid version; otherwise it's an ordinary boot.
  const validOtaVersion = otaVersion !== undefined && FIRMWARE_VERSION_PATTERN.test(otaVersion);

  if (otaStatus === "updated" && validOtaVersion) {
    otaAt = new Date().toISOString();
    console.log(`Device installed firmware ${otaVersion}: ${name} (${device_id})`);
    ping(c, device_id, "/log", `Installed firmware ${otaVersion}`);
  } else if (otaStatus === "rolled_back" && validOtaVersion) {
    otaAt = new Date().toISOString();
    console.log(`Device rolled back firmware ${otaVersion}: ${name} (${device_id})`);
    ping(c, device_id, "/failure", `Firmware ${otaVersion} failed and was rolled back`);
  } else {
    otaStatus = undefined;
    otaVersion = undefined;
  }

  // Installing an update (and the reboot that triggers a rollback) reboots
  // through the watchdog, which the OTA status above already reports.
  if (watchdogCausedReboot && !otaStatus) {
    console.log(`Device reboot caused by watchdog: ${name} (${device_id})`);
    ping(c, device_id, "/failure", "Watchdog caused reboot");
  } else if (!otaStatus) {
    console.log(`Device booted: ${name} (${device_id})`);
    ping(c, device_id, "/log", "Device booted");
  }

  if (device_id) {
    const now = new Date().toISOString();
    await board(c.env).updateDevice(device_id, {
      saved_state_writes,
      last_seen: now,
      booted_at: now,
      firmware_version: firmwareVersion,
      ota_status: otaStatus,
      ota_version: otaVersion,
      ota_at: otaAt,
    });
  } else {
    console.log("Warning: Ignoring device update without a device_id");
  }

  return c.body(null, 204);
});

// 204 if the board should keep its firmware, otherwise 200 with the version
// it should install.
app.get("/firmware/latest", async (c) => {
  const deviceId = c.req.query("device_id");
  const version = c.req.query("version");
  const stub = board(c.env);

  if (deviceId) {
    await stub.updateDevice(deviceId, { firmware_version: version });
  }

  const info = await stub.getFirmwareInfo();
  if (!info || info.version === version) {
    return c.body(null, 204);
  }
  return c.text(info.version);
});

// The image is AES encrypted with the boards' key, so it's safe to serve
// publicly.
app.get("/firmware/image", async (c) => {
  const deviceId = c.req.query("device_id");
  const firmware = await board(c.env).getFirmwareImage();

  if (!firmware) {
    return c.body(null, 404);
  }
  // A new upload since the board's version check: make it check again.
  if (c.req.query("target_version") !== firmware.version) {
    return c.body(null, 409);
  }

  console.log(
    `Device ${getDeviceName(deviceId)} (${deviceId}) downloading firmware ${firmware.version}`,
  );
  ping(c, deviceId, "/log", `Downloading firmware ${firmware.version}`);

  return c.body(firmware.image, 200, { "Content-Type": "application/octet-stream" });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

// Better Auth: signing in and out, the session, managing accounts and API keys
app.all("/api/auth/*", (c) => accounts.handleAuthRequest(c.env, c.req.raw));

// Until the first account exists, the admin page offers to create it, an
// admin, for whoever knows the deploy's SETUP_PASSWORD.
app.get("/api/setup", async (c) => c.json({ needed: await accounts.needsSetup(c.env) }));

app.post("/api/setup", async (c) => {
  // Once there's an account the setup password does nothing, so don't tell
  // anyone guessing it whether a guess was right.
  if (!(await accounts.needsSetup(c.env))) {
    return c.text("An account already exists\n", 409);
  }
  // Not "wrong": no guess can be right, so the deploy needs its secret.
  if (!c.env.SETUP_PASSWORD) {
    return c.text(
      "This server has no SETUP_PASSWORD, so nobody can create the first account\n",
      403,
    );
  }
  if (!(await accounts.allowSetupAttempt(c.env, c.req.raw))) {
    return c.text("Too many tries: wait a few seconds\n", 429);
  }
  const body: unknown = await c.req.json().catch(() => undefined);
  const { setupPassword, name, email, password } = isRecord(body) ? body : {};
  if (!(await isSetupPassword(c.env, setupPassword))) {
    return c.text("Wrong setup password\n", 403);
  }
  if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
    return c.text("Expected { setupPassword, name, email, password }\n", 400);
  }
  const created = await accounts.createFirstAccount(c.env, c.req.raw, {
    name,
    email,
    password,
  });
  if (typeof created === "string") {
    return c.text(`${created}\n`, 400);
  }
  return created ? c.body(null, 201) : c.text("An account already exists\n", 409);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Compares digests, which are the same length, looking at every byte
 * whatever the earlier ones were, so the time it takes says nothing about
 * how much of the password was right.
 */
async function isSetupPassword(env: Env, given: unknown): Promise<boolean> {
  const expected = env.SETUP_PASSWORD;
  if (!expected || typeof given !== "string") {
    return false;
  }
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return a.reduce((differences, byte, i) => differences | (byte ^ (b[i] ?? 0)), 0) === 0;
}

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// ---------------------------------------------------------------------------
// Admin (signed in, or with an API key)
// ---------------------------------------------------------------------------

async function getState(env: Env): Promise<BoardState> {
  const stub = board(env);
  const [lines, screens, devices, firmware] = await Promise.all([
    stub.getLines(),
    stub.getScreenEtags(),
    stub.getDevices(),
    stub.getFirmwareInfo(),
  ]);
  return {
    // RPC types widen the tuple to string[]; getLines() always returns six.
    lines: isLines(lines) ? lines : [...EMPTY_LINES],
    screens,
    devices: devices
      .map((device) => ({ ...device, name: getDeviceName(device.id) }))
      .toSorted((a, b) => deviceSortIndex(a.id) - deviceSortIndex(b.id)),
    firmware,
  };
}

app.get("/api/state", requireViewer, async (c) => c.json(await getState(c.env)));

app.put("/api/lines", requireViewer, async (c) => {
  const body: unknown = await c.req.json().catch(() => undefined);
  const lines =
    typeof body === "object" && body !== null && "lines" in body ? body.lines : undefined;
  if (!isLines(lines)) {
    return c.text("Expected { lines: [six strings] }\n", 400);
  }
  if (lines.some((line) => line.length > MAX_LINE_LENGTH)) {
    return c.text(`Each line is at most ${MAX_LINE_LENGTH} characters\n`, 400);
  }
  await board(c.env).setLines(trimLines(lines));
  return c.json(await getState(c.env));
});

// The bits currently stored for a screen, exactly as a board downloads them.
app.get("/api/screens/:id{[0-9]+}", requireViewer, async (c) => {
  const id = Number(c.req.param("id"));
  if (id < 1 || id > SCREEN_COUNT) {
    return c.notFound();
  }
  const screen = await board(c.env).getScreen(id);
  return c.body(screen.buffer, 200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    Etag: screen.etag,
  });
});

// Upload the OTA image (build/ehymnboard_fota_image_encrypted.bin) and its
// version (build/firmware_version.txt). Every board running a different
// version installs it.
app.post("/firmware", requireAdmin, async (c) => {
  const form = await c.req.parseBody();
  const version = typeof form.version === "string" ? form.version.trim() : "";
  const image = form.image;

  // "-" means "no firmware" in the board's state message
  if (!FIRMWARE_VERSION_PATTERN.test(version) || version === "-") {
    return c.text("Invalid or missing version\n", 400);
  }
  if (!(image instanceof File)) {
    return c.text("Missing image\n", 400);
  }

  const data = await image.arrayBuffer();
  if (data.byteLength === 0) {
    return c.text("Image is empty\n", 400);
  }
  if (data.byteLength % FIRMWARE_PAGE_SIZE !== 0) {
    return c.text(`Image size must be a multiple of ${FIRMWARE_PAGE_SIZE} bytes\n`, 400);
  }
  if (data.byteLength > FIRMWARE_MAX_SIZE) {
    return c.text(`Image is larger than ${FIRMWARE_MAX_SIZE} bytes\n`, 400);
  }

  const info = await board(c.env).saveFirmware(version, data);
  console.log(`Firmware ${version} uploaded (${info.size} bytes) by ${c.get("viewer").email}`);
  return c.text(`Uploaded firmware ${version}\n`, 201);
});

// Everything else is the React admin, served from static assets. It holds
// nothing secret: it signs in, and then asks the API above.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
