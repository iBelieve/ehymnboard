import { useEffect, useState } from "react";
import type { DeviceWithName, FirmwareInfo } from "../shared/api";
import { prettyDate } from "./prettyDate";

function describe(device: DeviceWithName, now: Date): string {
  const parts = [];
  if (device.last_seen) parts.push(`last seen ${prettyDate(device.last_seen, now)}`);
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
}: {
  devices: DeviceWithName[];
  firmware: FirmwareInfo | null;
}) {
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
        <div key={device.id} className="flex items-center gap-2 text-lg">
          {device.name} ({describe(device, now)})
          {device.etag_stuck_at && (
            <span className="badge badge-warning">
              Re-downloading every poll since {prettyDate(device.etag_stuck_at, now)}
            </span>
          )}
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
