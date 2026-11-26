import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "../../src/client/App";
import type { BoardState } from "../../src/shared/api";
import { EMPTY_LINES, SCREEN_BYTES, type Lines } from "../../src/shared/screen";

const SAVED: Lines = ["123", "", "456", "", "789", "Easter"];

/** A screen's stored bits: `lit` set pixels, so its image says which it is. */
function bits(lit: number) {
  const buffer = new Uint8Array(SCREEN_BYTES);
  buffer.fill(0xff, 0, lit / 8);
  return buffer;
}

/**
 * The Worker's API as the page uses it. `respond` lets a test answer a
 * request itself (or hold it), and `requests` records each one.
 */
class FakeServer {
  state: BoardState = {
    lines: [...SAVED],
    screens: [1, 2, 3].map((id) => ({ id, etag: `v1-${id}` })),
    devices: [],
    firmware: null,
  };
  requests: { method: string; url: string; body?: unknown }[] = [];
  respond?: (method: string, url: string) => Promise<Response> | undefined;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url, body });
    const answer = this.respond?.(method, url);
    if (answer) return answer;
    if (method === "PUT" && url === "/api/lines") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what saveLines sends
      this.state.lines = (body as { lines: Lines }).lines.map((line) => line.trim()) as Lines;
      this.state.screens = this.state.screens.map(({ id }) => ({ id, etag: `v2-${id}` }));
      return Response.json(this.state);
    }
    if (url === "/api/state") return Response.json(this.state);
    const id = /^\/api\/screens\/(\d)$/.exec(url)?.[1];
    if (id) {
      const etag = this.state.screens[Number(id) - 1]!.etag;
      return new Response(bits(Number(id) * 8), { headers: { Etag: etag } });
    }
    return new Response("Not Found", { status: 404 });
  };

  count(method: string, url: string) {
    return this.requests.filter((r) => r.method === method && r.url === url).length;
  }
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
});

function inputs() {
  return [1, 2, 3, 4, 5, 6].map((n) => screen.getByLabelText<HTMLInputElement>(`Line ${n}`));
}

function button(name: "Apply" | "Clear") {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}

function alertText() {
  return screen.queryByRole("alert")?.textContent;
}

function values() {
  return inputs().map((input) => input.value);
}

function images() {
  return [...document.querySelectorAll("image")].map((image) => image.getAttribute("href"));
}

async function loaded() {
  render(<App />);
  await waitFor(() => expect(values()).toEqual(SAVED));
}

test("the text boxes wait for the saved lines", async () => {
  render(<App />);
  expect(values()).toEqual(EMPTY_LINES);
  expect(inputs().every((input) => input.disabled)).toBe(true);
  expect(button("Apply").disabled).toBe(true);
  expect(button("Clear").disabled).toBe(true);
  await waitFor(() => expect(values()).toEqual(SAVED));
  expect(inputs().some((input) => input.disabled)).toBe(false);
  expect(button("Apply").disabled).toBe(false);
  expect(button("Clear").disabled).toBe(false);
  expect(alertText()).toBeUndefined();
});

test("the buttons wait for a save to finish", async () => {
  const user = userEvent.setup();
  await loaded();
  let answer!: () => void;
  server.respond = (method) =>
    method === "PUT"
      ? new Promise((resolve) => (answer = () => resolve(Response.json(server.state))))
      : undefined;
  await user.click(button("Apply"));
  expect(button("Apply").disabled).toBe(true);
  expect(button("Clear").disabled).toBe(true);
  await act(() => {
    answer();
    return Promise.resolve();
  });
  await waitFor(() => expect(button("Apply").disabled).toBe(false));
  expect(button("Clear").disabled).toBe(false);
});

test("a save that works clears the last one's error", async () => {
  const user = userEvent.setup();
  await loaded();
  server.respond = (method) =>
    method === "PUT" ? Promise.resolve(new Response("busy", { status: 503 })) : undefined;
  await user.click(button("Apply"));
  await waitFor(() => expect(alertText()).toBe("Error: 503 busy"));
  server.respond = undefined;
  await user.click(button("Apply"));
  await waitFor(() => expect(server.count("PUT", "/api/lines")).toBe(2));
  await waitFor(() => expect(alertText()).toBeUndefined());
});

test("after a failed first load, the next poll fills in the lines", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  server.respond = (_method, url) =>
    url === "/api/state" ? Promise.resolve(new Response("starting", { status: 503 })) : undefined;
  render(<App />);
  await waitFor(() => expect(alertText()).toBe("Error: 503 starting"));
  server.respond = undefined;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await waitFor(() => expect(values()).toEqual(SAVED));
  expect(alertText()).toBeUndefined();
});

test("polling stops when the page goes away", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { unmount } = render(<App />);
  await waitFor(() => expect(values()).toEqual(SAVED));
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(server.count("GET", "/api/state")).toBe(1);
});

test("the preview shows the bits the boards download", async () => {
  await loaded();
  await waitFor(() => expect(images()).toEqual(["data:test,8", "data:test,16", "data:test,24"]));
  expect(server.count("GET", "/api/screens/1")).toBe(1);
});

test("editing previews the draft, and Apply saves it", async () => {
  const user = userEvent.setup();
  await loaded();
  await waitFor(() => expect(images()[0]).toBe("data:test,8"));
  await user.clear(inputs()[0]!);
  await user.type(inputs()[0]!, " 321 ");
  screen.getByText("Previewing unsaved changes");
  // Rendered in the browser, not the stored bits.
  expect(images()[0]).not.toBe("data:test,8");

  await user.click(button("Apply"));
  await waitFor(() => expect(values()[0]).toBe("321"));
  expect(server.requests.find((r) => r.method === "PUT")?.body).toEqual({
    lines: [" 321 ", ...SAVED.slice(1)],
  });
  expect(screen.queryByText("Previewing unsaved changes")).toBeNull();
  // The new bits, for the new etags.
  await waitFor(() => expect(server.count("GET", "/api/screens/3")).toBe(2));
});

test("Clear saves empty lines", async () => {
  const user = userEvent.setup();
  await loaded();
  await user.click(button("Clear"));
  await waitFor(() => expect(values()).toEqual(EMPTY_LINES));
  expect(server.requests.find((r) => r.method === "PUT")?.body).toEqual({ lines: EMPTY_LINES });
});

test("a failed save says why and keeps the edits", async () => {
  const user = userEvent.setup();
  await loaded();
  server.respond = (method) =>
    method === "PUT" ? Promise.resolve(new Response("too long", { status: 400 })) : undefined;
  await user.type(inputs()[1]!, "x");
  await user.click(button("Apply"));
  await waitFor(() => expect(alertText()).toBe("Error: 400 too long"));
  expect(values()[1]).toBe("x");
  expect(button("Apply").disabled).toBe(false);
});

test("a failed load says why", async () => {
  server.respond = (_method, url) =>
    url === "/api/state" ? Promise.reject(new TypeError("Failed to fetch")) : undefined;
  render(<App />);
  await waitFor(() => expect(alertText()).toBe("TypeError: Failed to fetch"));
  expect(inputs().every((input) => input.disabled)).toBe(true);
});

test("a failed screen download says why, and is tried again", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let fail = true;
  server.respond = (_method, url) =>
    url === "/api/screens/2" && fail
      ? Promise.resolve(new Response("oops", { status: 500 }))
      : undefined;
  await loaded();
  await screen.findByText("Error: 500 oops");
  fail = false;
  // The next poll clears the error; a new state then retries the screen.
  server.state = { ...server.state, devices: [] };
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await waitFor(() => expect(screen.queryByText("Error: 500 oops")).toBeNull());
  await waitFor(() => expect(images()[1]).toBe("data:test,16"));
});

test("polling follows lines changed elsewhere, unless they're being edited", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const user = userEvent.setup();
  await loaded();

  server.state = { ...server.state, lines: ["1", "2", "3", "4", "5", "6"] };
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await waitFor(() => expect(values()).toEqual(["1", "2", "3", "4", "5", "6"]));

  await user.type(inputs()[0]!, "0");
  server.state = { ...server.state, lines: ["a", "b", "c", "d", "e", "f"] };
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await waitFor(() => expect(server.count("GET", "/api/state")).toBe(3));
  expect(values()).toEqual(["10", "2", "3", "4", "5", "6"]);
});

test("a poll that overlaps a save doesn't put back the old lines", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const user = userEvent.setup();
  await loaded();

  // The poll starts before the save and answers after it, with the old lines.
  let answerPoll!: () => void;
  const before = structuredClone(server.state);
  server.respond = (_method, url) =>
    url === "/api/state"
      ? new Promise((resolve) => (answerPoll = () => resolve(Response.json(before))))
      : undefined;
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  await user.click(button("Clear"));
  await waitFor(() => expect(values()).toEqual(EMPTY_LINES));
  await act(() => {
    answerPoll();
    return Promise.resolve();
  });
  expect(values()).toEqual(EMPTY_LINES);
});

test("bits newer than the state are kept, and not fetched again", async () => {
  // The lines change between the state and the screen download.
  server.respond = (_method, url) =>
    url === "/api/screens/1"
      ? Promise.resolve(new Response(bits(64), { headers: { Etag: "v9-1" } }))
      : undefined;
  await loaded();
  await waitFor(() => expect(server.count("GET", "/api/screens/3")).toBe(1));
  // Not the state's etag, so the saved lines are rendered instead.
  await waitFor(() => expect(images()[1]).toBe("data:test,16"));
  expect(images()[0]).not.toBe("data:test,64");
  expect(server.count("GET", "/api/screens/1")).toBe(1);
});
