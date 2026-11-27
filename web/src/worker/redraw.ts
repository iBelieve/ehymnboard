// The nightly redraw: once a night, while nobody is in the church, the server
// asks each board to redraw every panel with a full refresh. Waveshare's
// manual says to refresh the panels at least once every 24 hours, or old
// images can stick, and a board can otherwise show the same hymns for a week.

/** The local hour (0-23, the board's time zone) the redraw window opens. */
export const REDRAW_HOUR = 3;

/**
 * How many hours the window stays open: a board offline at 3 AM is asked
 * once it's back, up to 5 AM, and a night whose clocks skip from 3 AM to 4 AM
 * (as in much of Europe in spring) still gets its redraw.
 */
export const REDRAW_WINDOW_HOURS = 2;

/**
 * A board isn't asked again this soon after its last redraw, so the alarm,
 * which runs every 10 minutes, asks once in the window, and a board that
 * reconnects in it isn't asked twice.
 */
export const REDRAW_SPACING_MS = 12 * 60 * 60_000;

/**
 * How long after asking a board to redraw its ETag-less downloads of the
 * images it shows count as the redraw. Its retries of a failed download stop
 * within minutes (after 3 minutes it reboots).
 */
export const REDRAW_DOWNLOADS_MS = 60 * 60_000;

/**
 * The hour (0-23) at `now` in `timeZone`, an IANA time zone such as
 * "America/Chicago". An unknown or missing time zone counts as UTC.
 */
export function localHour(now: number, timeZone: string | undefined): number {
  let format: Intl.DateTimeFormat;
  try {
    // Without a time zone, Intl takes the runtime's own, which isn't always UTC
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? "UTC",
      hour: "numeric",
      hourCycle: "h23",
    });
  } catch {
    // A RangeError for a time zone this runtime doesn't know
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      hourCycle: "h23",
    });
  }
  const hour = format.formatToParts(now).find((part) => part.type === "hour")?.value;
  return Number(hour);
}

/**
 * Whether a board in `timeZone` is due its nightly redraw at `now`, given
 * when it was last asked (ms since the epoch, if ever).
 */
export function redrawDue(
  now: number,
  timeZone: string | undefined,
  lastRedrawAt: number | undefined,
): boolean {
  const hour = localHour(now, timeZone);
  if (hour < REDRAW_HOUR || hour >= REDRAW_HOUR + REDRAW_WINDOW_HOURS) {
    return false;
  }
  return lastRedrawAt === undefined || now - lastRedrawAt >= REDRAW_SPACING_MS;
}
