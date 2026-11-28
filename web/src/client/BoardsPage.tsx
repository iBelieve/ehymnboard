import { useEffect, useState } from "react";
import type { BoardState, DeviceWithName } from "../shared/api";
import { fetchState } from "./api";
import { prettyDate } from "./prettyDate";
import { Section, SettingsPage } from "./Settings";

const REFRESH_MS = 10_000;

/** Every board's status in a table, refreshed every 10 s. */
export function BoardsPage() {
  const [state, setState] = useState<BoardState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchState().then(
        (next) => {
          if (cancelled) return;
          setState(next);
          setError(undefined);
        },
        (e: unknown) => !cancelled && setError(String(e)),
      );
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Re-render every 30 s so "just now" ages even between refreshes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <SettingsPage title="Hymn Boards" wide>
      <Section>
        {error && <div className="text-error mb-4 text-sm">{error}</div>}
        {state && state.devices.length === 0 && (
          <p className="opacity-75">No boards have checked in yet.</p>
        )}
        {state && state.devices.length > 0 && <BoardTable devices={state.devices} now={now} />}
        {state?.firmware && (
          <p className="mt-4 text-sm opacity-75">
            Latest firmware {state.firmware.version} (uploaded{" "}
            {prettyDate(state.firmware.uploaded_at, now)})
          </p>
        )}
      </Section>
    </SettingsPage>
  );
}

/**
 * Below Tailwind's `sm`, hides the headings and turns each row into a block,
 * each labelled cell a line led by its `data-label`, the board's name first.
 */
const STACKED_ON_PHONES = [
  "max-sm:[&_thead]:hidden",
  "max-sm:[&_tr]:block max-sm:[&_tr]:py-3",
  "max-sm:[&_td]:border-0 max-sm:[&_td]:px-0 max-sm:[&_td]:py-1",
  "max-sm:[&_td[data-label]]:flex max-sm:[&_td[data-label]]:justify-between max-sm:[&_td[data-label]]:gap-4",
  "max-sm:[&_td[data-label]]:before:opacity-60 max-sm:[&_td[data-label]]:before:content-[attr(data-label)]",
].join(" ");

function BoardTable({ devices, now }: { devices: DeviceWithName[]; now: Date }) {
  return (
    // On a phone each board is a block of labelled lines instead, since six
    // columns don't fit across one.
    <div className="overflow-x-auto">
      <table className={`table ${STACKED_ON_PHONES}`}>
        <thead>
          <tr>
            <th>Board</th>
            <th>Status</th>
            <th>Last seen</th>
            <th>Last updated</th>
            <th>Booted</th>
            <th>Firmware</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.id}>
              <td>
                <div className="font-medium">{device.name}</div>
                {device.name !== device.id && (
                  <div className="font-mono text-xs opacity-60">{device.id}</div>
                )}
              </td>
              <td data-label="Status">
                <Status device={device} now={now} />
              </td>
              <td data-label="Last seen">
                {/* Always shown, like the old admin's line (whose template
                    failed outright on a board that had never been seen). */}
                {device.last_seen ? <When iso={device.last_seen} now={now} /> : "never"}
              </td>
              <td data-label="Last updated">
                <When iso={device.last_updated_at} now={now} />
              </td>
              <td data-label="Booted">
                <When iso={device.booted_at} now={now} />
              </td>
              <td data-label="Firmware">
                <div className="max-sm:text-right">
                  {device.firmware_version ?? <Blank />}
                  {device.ota_status === "rolled_back" && device.ota_at && (
                    <div>
                      <span className="badge badge-warning badge-sm h-auto py-0.5">
                        Rolled back {device.ota_version} {prettyDate(device.ota_at, now)}
                      </span>
                    </div>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live or Offline on its socket. A board that has never opened one (firmware
 * from before the sockets) gets neither.
 */
function Status({ device, now }: { device: DeviceWithName; now: Date }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {device.live ? (
        <span className="badge badge-success" title="Connected: gets new lines at once">
          Live
        </span>
      ) : device.connected_at ? (
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
      ) : (
        <Blank />
      )}
      {device.etag_stuck_at && (
        <span className="badge badge-warning h-auto">
          Re-downloading every poll since {prettyDate(device.etag_stuck_at, now)}
        </span>
      )}
    </div>
  );
}

/** How long ago, with the exact time on hover. */
function When({ iso, now }: { iso: string | null; now: Date }) {
  if (!iso) return <Blank />;
  return <span title={new Date(iso).toLocaleString()}>{prettyDate(iso, now)}</span>;
}

function Blank() {
  return <span className="opacity-40">–</span>;
}
