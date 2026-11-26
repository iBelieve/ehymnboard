import { useEffect, useState } from "react";
import type { BoardState, DeviceWithName, FirmwareInfo } from "../shared/api";
import { BoardDetails } from "./BoardDetails";
import { prettyDate } from "./prettyDate";

function describe(device: DeviceWithName, now: Date): string {
  const parts = [];
  // Always present, like the old admin's line (whose template failed outright
  // on a board that had never been seen).
  parts.push(`last seen ${device.last_seen ? prettyDate(device.last_seen, now) : "never"}`);
  if (device.last_updated_at) parts.push(`last updated ${prettyDate(device.last_updated_at, now)}`);
  if (device.booted_at) parts.push(`booted ${prettyDate(device.booted_at, now)}`);
  if (device.firmware_version) parts.push(`firmware ${device.firmware_version}`);
  if (device.ota_status === "rolled_back" && device.ota_at) {
    parts.push(`rolled back ${device.ota_version} ${prettyDate(device.ota_at, now)}`);
  }
  return parts.join(", ");
}

export function DeviceList({
  devices,
  firmware,
  onState,
}: {
  devices: DeviceWithName[];
  firmware: FirmwareInfo | null;
  /** A newer state, from a board's "Refresh now" */
  onState: (state: BoardState) => void;
}) {
  // The boards whose Details are open
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Re-render every 30 s so "just now" ages even between refreshes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (devices.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 text-white max-lg:mb-8 lg:mt-4">
      {devices.map((device) => (
        <div key={device.id}>
          <div className="flex items-center gap-2 text-lg">
            {device.name} ({describe(device, now)})
            {device.live ? (
              <span className="badge badge-success" title="Connected: gets new lines at once">
                Live
              </span>
            ) : (
              device.connected_at && (
                <span
                  className="badge badge-ghost"
                  title={
                    device.disconnected_at
                      ? `Disconnected ${prettyDate(device.disconnected_at, now)}`
                      : "Not connected"
                  }
                >
                  Offline
                </span>
              )
            )}
            {device.etag_stuck_at && (
              <span className="badge badge-warning">
                Re-downloading every poll since {prettyDate(device.etag_stuck_at, now)}
              </span>
            )}
            <button
              type="button"
              className="btn btn-xs btn-ghost text-white"
              aria-expanded={open.has(device.id)}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(device.id)) next.add(device.id);
                  return next;
                })
              }
            >
              {open.has(device.id) ? "Hide details" : "Details"}
            </button>
          </div>
          {open.has(device.id) && <BoardDetails device={device} now={now} onState={onState} />}
        </div>
      ))}
      {firmware && (
        <div className="mt-1 text-sm opacity-75">
          Latest firmware {firmware.version} (uploaded {prettyDate(firmware.uploaded_at, now)})
        </div>
      )}
    </div>
  );
}
