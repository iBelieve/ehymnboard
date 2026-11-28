import { useEffect, useState } from "react";
import type { BoardState, DeviceWithName, HealthSample } from "../shared/api";
import { fetchHealthHistory, refreshDiagnostics } from "./api";
import { describeDrop, describeReset, duration, kilobytes, signal, uptimeNow } from "./diagnostics";
import { prettyDate } from "./prettyDate";

/**
 * A board's diagnostics: what it said about its signal, uptime, last reset,
 * last socket and heap, its hourly trend for the last week, and a "Refresh
 * now" that asks a connected board for a fresh report.
 */
export function BoardDetails({
  device,
  now,
  onState,
}: {
  device: DeviceWithName;
  now: Date;
  onState: (state: BoardState) => void;
}) {
  const [history, setHistory] = useState<HealthSample[]>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetchHealthHistory(device.id)
      .then((samples) => !cancelled && setHistory(samples))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [device.id]);

  async function refresh() {
    setRefreshing(true);
    setError(undefined);
    try {
      onState(await refreshDiagnostics(device.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  const uptime = uptimeNow(device, now);
  const health = device.health;
  const rows: [string, string][] = [];
  if (device.rssi !== null) rows.push(["Signal", signal(device.rssi)]);
  if (uptime !== null) rows.push(["Uptime", duration(uptime)]);
  if (device.last_reset) {
    rows.push([
      "Last reset",
      `${describeReset(device.last_reset)} (${prettyDate(device.last_reset.at, now)})`,
    ]);
  }
  if (device.last_drop) {
    rows.push([
      "Last reconnect",
      `${describeDrop(device.last_drop)} (${prettyDate(device.last_drop.at, now)})`,
    ]);
  }
  if (health) {
    if (health.heap_free !== null && health.heap_min !== null) {
      rows.push([
        "Memory",
        `${kilobytes(health.heap_free)} free, ${kilobytes(health.heap_min)} at the least`,
      ]);
    }
    const counts = [
      [health.drops, "dropped connection", "dropped connections"],
      [health.connect_fails, "failed connect", "failed connects"],
      [health.pong_timeouts, "unanswered ping", "unanswered pings"],
      [health.image_fails, "failed download", "failed downloads"],
      [health.wifi_drops, "WiFi drop", "WiFi drops"],
      [health.tls_oom, "TLS out of memory", "TLS out of memory"],
    ] as const;
    rows.push([
      "Since boot",
      counts
        .filter(([count]) => count !== null)
        .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
        .join(", "),
    ]);
  }

  return (
    <div className="max-w-2xl py-2 text-base text-gray-900">
      {rows.length === 0 ? (
        <p className="text-gray-600">
          This board hasn't reported any diagnostics yet: its firmware may be too old.
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-gray-600">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {device.health_at && (
        <p className="mt-1 text-sm text-gray-600">
          Memory and counts from {prettyDate(device.health_at, now)}
        </p>
      )}

      {history && history.length > 1 && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Sparkline
            title="Signal, last 7 days"
            points={seriesOf(history, (sample) => sample.rssi)}
            format={(value) => `${value} dBm`}
          />
          <Sparkline
            title="Least free memory, last 7 days"
            points={seriesOf(history, (sample) => sample.heap_min)}
            format={kilobytes}
          />
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!device.live || refreshing}
          title={device.live ? "Ask the board for a report now" : "The board isn't connected"}
          onClick={() => void refresh()}
        >
          {refreshing ? "Asking the board..." : "Refresh now"}
        </button>
        {error && <span className="text-error text-sm">{error}</span>}
      </div>
    </div>
  );
}

type Point = { at: number; value: number };

function seriesOf(history: HealthSample[], pick: (sample: HealthSample) => number | null): Point[] {
  return history.flatMap((sample) => {
    const value = pick(sample);
    return value === null ? [] : [{ at: Date.parse(sample.at), value }];
  });
}

const WIDTH = 240;
const HEIGHT = 56;
const PAD = 4;

/**
 * One series over time: a 2px line, its latest value and range as text, and
 * a crosshair with the value under the pointer. The table below it has every
 * point.
 */
function Sparkline({
  title,
  points,
  format,
}: {
  title: string;
  points: Point[];
  format: (value: number) => string;
}) {
  const [hover, setHover] = useState<number>();
  if (points.length < 2) {
    return null;
  }
  const first = points[0]!.at;
  const last = points.at(-1)!.at;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (at: number) => PAD + ((at - first) / Math.max(1, last - first)) * (WIDTH - 2 * PAD);
  const y = (value: number) =>
    max === min ? HEIGHT / 2 : PAD + ((max - value) / (max - min)) * (HEIGHT - 2 * PAD);
  const line = points.map((point) => `${x(point.at)},${y(point.value)}`).join(" ");
  const shown = hover === undefined ? undefined : points[hover];
  const latest = points.at(-1)!;

  return (
    <figure className="m-0">
      <figcaption className="flex justify-between gap-2 text-sm">
        <span className="text-gray-600">{title}</span>
        <span className="whitespace-nowrap">{format(shown?.value ?? latest.value)}</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-14 w-full touch-none"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}: from ${format(min)} to ${format(max)}, now ${format(latest.value)}`}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          // The inverse of x(), padding and all
          const across = ((e.clientX - box.left) / box.width) * WIDTH;
          const at = first + ((across - PAD) / (WIDTH - 2 * PAD)) * (last - first);
          let nearest = 0;
          points.forEach((point, i) => {
            if (Math.abs(point.at - at) < Math.abs(points[nearest]!.at - at)) nearest = i;
          });
          setHover(nearest);
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <line x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} stroke="#d4d4d4" />
        <polyline
          points={line}
          fill="none"
          stroke="#257de0"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {shown && (
          <line
            x1={x(shown.at)}
            x2={x(shown.at)}
            y1={0}
            y2={HEIGHT}
            stroke="#666666"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="flex justify-between text-xs text-gray-600">
        <span>
          {shown ? new Date(shown.at).toLocaleString() : `${format(min)} to ${format(max)}`}
        </span>
      </div>
      <details className="mt-1 text-xs text-gray-600">
        <summary className="cursor-pointer">Table</summary>
        <table className="table-xs table">
          <tbody>
            {points.map((point) => (
              <tr key={point.at}>
                <td>{new Date(point.at).toLocaleString()}</td>
                <td>{format(point.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
