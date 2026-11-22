import { expect, test } from "vitest";
import { prettyDate } from "../src/client/prettyDate";

const now = new Date("2026-11-22T12:00:00Z");

test("relative times", () => {
  expect(prettyDate("2026-11-22T11:59:30Z", now)).toBe("just now");
  expect(prettyDate("2026-11-22T11:58:30Z", now)).toBe("1 minute ago");
  expect(prettyDate("2026-11-22T11:30:00Z", now)).toBe("30 minutes ago");
  expect(prettyDate("2026-11-22T09:00:00Z", now)).toBe("3 hours ago");
  expect(prettyDate("2026-11-20T12:00:00Z", now)).toBe("2 days ago");
});

test("a browser clock behind the server's still says just now", () => {
  expect(prettyDate("2026-11-22T12:00:05Z", now)).toBe("just now");
});

test("older dates are absolute", () => {
  expect(prettyDate("2026-11-01T12:00:00Z", now)).toBe("on 01 Nov 26");
});
