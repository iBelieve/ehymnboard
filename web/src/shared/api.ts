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
  /** When the board was flagged for re-downloading a screen it already has. */
  etag_stuck_at: string | null;
  /** When the board's WebSocket last opened, and last closed. */
  connected_at: string | null;
  disconnected_at: string | null;
  /** What the board said its panels show: a JSON array of three etags. */
  shown_etags: string | null;
};

/** What the admin shows for a board: its row, plus whether its socket is up now. */
export type DeviceWithName = Device & { name: string; live: boolean };

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

/**
 * Who's signed in to the admin. Admins also manage accounts and upload
 * firmware; everyone can change the lines.
 */
export type Viewer = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
};
