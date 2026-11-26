import { act, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DeviceList } from "../../src/client/DeviceList";
import type { DeviceWithName } from "../../src/shared/api";

const NOW = new Date("2026-11-22T12:00:00Z");

function device(fields: Partial<DeviceWithName>): DeviceWithName {
  return {
    id: "E6614103E71F8D26",
    name: "Left",
    live: false,
    saved_state_writes: null,
    last_seen: null,
    last_updated_at: null,
    booted_at: null,
    firmware_version: null,
    ota_status: null,
    ota_version: null,
    ota_at: null,
    etag_stuck_at: null,
    connected_at: null,
    disconnected_at: null,
    shown_etags: null,
    ...fields,
  };
}

function renderAt(
  devices: DeviceWithName[],
  firmware: Parameters<typeof DeviceList>[0]["firmware"],
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  return render(<DeviceList devices={devices} firmware={firmware} />);
}

test("no boards, no list", () => {
  const { container } = renderAt([], {
    version: "abc",
    size: 1,
    sha256: "",
    uploaded_at: "2026-11-22T11:00:00Z",
  });
  expect(container.innerHTML).toBe("");
});

test("a board that has never been seen", () => {
  renderAt([device({})], null);
  screen.getByText("Left (last seen never)");
  expect(screen.queryByText("Offline")).toBeNull();
  expect(screen.queryByText(/Latest firmware/)).toBeNull();
});

test("everything known about a live board", () => {
  renderAt(
    [
      device({
        live: true,
        last_seen: "2026-11-22T11:59:50Z",
        last_updated_at: "2026-11-22T11:00:00Z",
        booted_at: "2026-11-21T12:00:00Z",
        firmware_version: "b444a37",
        ota_status: "rolled_back",
        ota_version: "c0ffee1",
        ota_at: "2026-11-22T10:00:00Z",
        connected_at: "2026-11-22T11:00:00Z",
        etag_stuck_at: "2026-11-22T11:30:00Z",
      }),
    ],
    { version: "c0ffee1", size: 1, sha256: "", uploaded_at: "2026-11-22T09:00:00Z" },
  );
  screen.getByText(
    "Left (last seen just now, last updated 1 hour ago, booted 1 day ago, firmware b444a37, rolled back c0ffee1 2 hours ago)",
  );
  expect(screen.getByText("Live").getAttribute("title")).toBe("Connected: gets new lines at once");
  screen.getByText("Re-downloading every poll since 30 minutes ago");
  screen.getByText("Latest firmware c0ffee1 (uploaded 3 hours ago)");
});

test("a rollback without a time isn't shown", () => {
  renderAt([device({ ota_status: "rolled_back", ota_version: "c0ffee1" })], null);
  screen.getByText("Left (last seen never)");
});

test("a board whose socket closed is offline", () => {
  renderAt(
    [
      device({ connected_at: "2026-11-22T10:00:00Z", disconnected_at: "2026-11-22T11:55:00Z" }),
      device({ id: "E661A4D41787452B", name: "Right", connected_at: "2026-11-22T10:00:00Z" }),
    ],
    null,
  );
  const [left, right] = screen.getAllByText("Offline");
  expect(left!.getAttribute("title")).toBe("Disconnected 5 minutes ago");
  expect(right!.getAttribute("title")).toBe("Not connected");
});

test("the times age while the page is open", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  render(<DeviceList devices={[device({ last_seen: NOW.toISOString() })]} firmware={null} />);
  screen.getByText("Left (last seen just now)");
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  screen.getByText("Left (last seen 2 minutes ago)");
});
