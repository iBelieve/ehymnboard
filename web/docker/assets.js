// Stands in for Workers Static Assets in the Docker image's workerd: serves the
// built client from a disk directory, with the same single-page-application
// fallback to index.html that wrangler.jsonc configures on Cloudflare.

const CONTENT_TYPES = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
};

export default {
  /**
   * @param {Request} request
   * @param {{ FILES: Fetcher }} env
   */
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let path = new URL(request.url).pathname;
    if (path.endsWith("/")) {
      path += "index.html";
    }
    // Only files have an extension; workerd answers a directory with a JSON
    // listing, so treat that as a miss.
    const isFile = path.slice(path.lastIndexOf("/")).includes(".");
    let res = isFile ? await env.FILES.fetch(fileRequest(path, request)) : undefined;
    if (!res || !res.ok) {
      // Like Cloudflare, only page navigations fall back to the app.
      if (!request.headers.get("Accept")?.includes("text/html")) {
        return new Response("Not Found", { status: 404 });
      }
      path = "/index.html";
      res = await env.FILES.fetch(fileRequest(path, request));
    }

    const headers = new Headers(res.headers);
    const extension = path.slice(path.lastIndexOf(".") + 1);
    headers.set("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
    // Vite fingerprints everything under /assets/.
    headers.set(
      "Cache-Control",
      path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return new Response(res.body, { status: res.status, headers });
  },
};

/** @param {string} path @param {Request} request */
function fileRequest(path, request) {
  return new Request(`http://files${path}`, { method: request.method });
}
