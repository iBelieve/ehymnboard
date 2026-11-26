import { describe, expect, test } from "vitest";
import assets from "../selfhost/assets.js";

/** The client-files disk service: `files` by path, and workerd's JSON listing for a directory. */
function env(files: Record<string, string>) {
  const requests: { url: string; method: string }[] = [];
  const FILES = {
    fetch: (request: Request) => {
      requests.push({ url: request.url, method: request.method });
      const path = new URL(request.url).pathname;
      if (path in files) return Promise.resolve(new Response(files[path]));
      if (path === "/assets") return Promise.resolve(Response.json(["index-abc.js"]));
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  };
  return { env: { FILES }, requests };
}

const FILES = {
  "/index.html": "<!doctype html>",
  "/assets/index-abc.js": "console.log(1)",
  "/church-lent.jpg": "jpeg",
  "/fonts/Display.otf": "font",
};

function get(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, init);
}

const PAGE = { headers: { Accept: "text/html,application/xhtml+xml" } };

describe("the self-hosted static assets Worker", () => {
  test("serves a file with its content type", async () => {
    const { env: e, requests } = env(FILES);
    const res = await assets.fetch(get("/church-lent.jpg"), e);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("jpeg");
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(requests).toEqual([{ url: "http://files/church-lent.jpg", method: "GET" }]);
  });

  test("caches Vite's fingerprinted assets for good", async () => {
    const res = await assets.fetch(get("/assets/index-abc.js"), env(FILES).env);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  test("an unknown extension is a plain download", async () => {
    const res = await assets.fetch(get("/fonts/Display.otf"), env(FILES).env);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("a directory serves its index.html", async () => {
    const res = await assets.fetch(get("/"), env(FILES).env);
    expect(await res.text()).toBe("<!doctype html>");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("a page navigation to an app route gets the app", async () => {
    const { env: e, requests } = env(FILES);
    const res = await assets.fetch(get("/boards/left", PAGE), e);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html>");
    // No extension, so not looked up as a file: workerd would list a directory.
    expect(requests.map((r) => r.url)).toEqual(["http://files/index.html"]);
  });

  test("a page navigation to a missing file gets the app", async () => {
    const res = await assets.fetch(get("/missing.png", PAGE), env(FILES).env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("anything else missing is a 404", async () => {
    for (const path of ["/missing.png", "/assets"]) {
      const res = await assets.fetch(get(path), env(FILES).env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
    }
  });

  test("HEAD asks the disk for HEAD", async () => {
    const { env: e, requests } = env(FILES);
    const res = await assets.fetch(get("/church-lent.jpg", { method: "HEAD" }), e);
    expect(res.status).toBe(200);
    expect(requests[0]?.method).toBe("HEAD");
  });

  test("only GET and HEAD", async () => {
    const res = await assets.fetch(get("/index.html", { method: "POST" }), env(FILES).env);
    expect(res.status).toBe(405);
  });
});
