// Types shared by the Worker's JSON API and the React admin.

import type { Lines } from "./screen";

/** What the server knows about a board, from its last few requests. */
export type Device = {
  id: string;
  saved_state_writes: number | null;
  last_seen: string | null;
  last_updated_at: string | null;
  booted_at: string | null;
  firmware_version: string | null;
  ota_status: string | null;
  ota_version: string | null;
  ota_at: string | null;
};

export type DeviceWithName = Device & { name: string };

/** Query parameters every device request carries. */
export type DeviceStatusParams = {
  device_id?: string;
  saved_state_writes?: number;
};

export type FirmwareInfo = {
  version: string;
  size: number;
  sha256: string;
  uploaded_at: string;
};

export type BoardState = {
  lines: Lines;
  screens: { id: number; etag: string }[];
  devices: DeviceWithName[];
  firmware: FirmwareInfo | null;
};
