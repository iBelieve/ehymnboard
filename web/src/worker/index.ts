import { Hono, type Context, type MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { BoardState, DeviceStatusParams } from "../shared/api";
import { isLines, SCREEN_COUNT, type Lines } from "../shared/screen";
import { deviceSortIndex, getDeviceName, pingHealthcheck } from "./devices";

export { HymnBoard } from "./hymn-board";

// Must match the device: OTA images are written to flash in 256-byte pages,
// the download slot is 1000 KB, and versions are at most 47 characters.
const FIRMWARE_PAGE_SIZE = 256;
const FIRMWARE_MAX_SIZE = 1000 * 1024;
const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,47}$/;

const MAX_LINE_LENGTH = 100;

type AppEnv = { Bindings: Env };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

/** Both boards share one HymnBoard instance. */
function board(env: Env) {
  return env.HYMN_BOARD.getByName("main");
}

/** Basic auth for the admin, only when credentials are configured. */
const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const username = c.env.BASIC_AUTH_USERNAME;
  const password = c.env.BASIC_AUTH_PASSWORD;
  if (!username || !password) {
    return next();
  }
  return basicAuth({ username, password, realm: "Login Required" })(c, next);
};

function deviceStatus(c: AppContext): DeviceStatusParams {
  return {
    device_id: c.req.query("device_id") || undefined,
    saved_state_writes: c.req.query("saved_state_writes") || undefined,
  };
}

/** Runs a healthchecks.io ping after the response is sent. */
function ping(c: AppContext, ...args: Parameters<typeof pingHealthcheck>) {
  c.executionCtx.waitUntil(pingHealthcheck(...args));
}

// ---------------------------------------------------------------------------
// Device endpoints. The firmware hard-codes these paths, the query parameters
// and the response bytes, so they must not change.
// ---------------------------------------------------------------------------

app.get("/ok", (c) => c.body(null, 204));

app.get("/images/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  if (id < 1 || id > SCREEN_COUNT) {
    return c.notFound();
  }

  // The firmware's HTTP client can't send headers, so it passes ?etag=.
  const etag = c.req.header("If-None-Match") || c.req.query("etag") || undefined;
  const status = deviceStatus(c);
  const result = await board(c.env).fetchImage(id, etag, status);

  // The firmware stores this bare 40-character value, so no quotes.
  c.header("Etag", result.etag);

  if (result.status === 304) {
    return c.body(null, 304);
  }

  console.log(
    `Device ${getDeviceName(status.device_id)} (${status.device_id}) updating image ${id} from ${etag} to ${result.etag}`,
  );
  ping(c, status.device_id, "/log", `Updating image ${id}`);

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

  if (otaStatus === "updated") {
    otaAt = new Date().toISOString();
    console.log(`Device installed firmware ${otaVersion}: ${name} (${device_id})`);
    ping(c, device_id, "/log", `Installed firmware ${otaVersion}`);
  } else if (otaStatus === "rolled_back") {
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

app.get("/device_healthy", async (c) => {
  const { device_id, saved_state_writes } = deviceStatus(c);

  console.log(`Device healthy: ${getDeviceName(device_id)} (${device_id})`);
  ping(c, device_id, "", "Device healthy");

  if (device_id) {
    await board(c.env).updateDevice(device_id, {
      saved_state_writes,
      last_seen: new Date().toISOString(),
      firmware_version: c.req.query("firmware_version"),
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
// Admin (basic auth)
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
    lines: lines as unknown as Lines,
    screens,
    devices: devices
      .map((device) => ({ ...device, name: getDeviceName(device.id) }))
      .toSorted((a, b) => deviceSortIndex(a.id) - deviceSortIndex(b.id)),
    firmware,
  };
}

app.get("/api/state", requireAuth, async (c) => c.json(await getState(c.env)));

app.put("/api/lines", requireAuth, async (c) => {
  const body = await c.req.json<{ lines?: unknown }>().catch(() => ({ lines: undefined }));
  const lines = body.lines;
  if (!isLines(lines) || lines.some((line) => line.length > MAX_LINE_LENGTH)) {
    return c.text("Expected { lines: [six strings] }", 400);
  }
  await board(c.env).setLines(lines.map((line) => line.trim()) as Lines);
  return c.json(await getState(c.env));
});

// The bits currently stored for a screen, exactly as a board downloads them.
app.get("/api/screens/:id{[0-9]+}", requireAuth, async (c) => {
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
app.post("/firmware", requireAuth, async (c) => {
  const form = await c.req.parseBody();
  const version = typeof form.version === "string" ? form.version.trim() : "";
  const image = form.image;

  if (!FIRMWARE_VERSION_PATTERN.test(version)) {
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
  console.log(`Firmware ${version} uploaded (${info.size} bytes)`);
  return c.text(`Uploaded firmware ${version}\n`, 201);
});

// Everything else is the React admin, served from static assets.
app.all("*", requireAuth, (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
