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
 * The time zone of a board whose own isn't known (Cloudflare gave none, or
 * one this runtime doesn't know): the boards so far are in the US, where 3 AM
 * UTC is an evening, when a church may be full.
 */
export const DEFAULT_TIME_ZONE = "America/Chicago";

/** Formats the hour (0-23) in `timeZone`, or is undefined for one this runtime doesn't know. */
function hourFormat(timeZone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
  } catch {
    // A RangeError for a time zone this runtime doesn't know
    return undefined;
  }
}

/**
 * The time zone a board's redraw follows: `timeZone`, an IANA time zone such
 * as "America/Chicago", or DEFAULT_TIME_ZONE if it's missing or one this
 * runtime doesn't know.
 */
export function redrawTimeZone(timeZone: string | undefined): string {
  // Without a time zone, Intl would take the runtime's own
  return timeZone !== undefined && hourFormat(timeZone) !== undefined
    ? timeZone
    : DEFAULT_TIME_ZONE;
}

/**
 * The hour (0-23) at `now` in `timeZone`, taken as redrawTimeZone() takes it,
 * or undefined if Intl gives none.
 */
export function localHour(now: number, timeZone: string | undefined): number | undefined {
  const format = hourFormat(redrawTimeZone(timeZone));
  const hour = Number(format?.formatToParts(now).find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) ? hour : undefined;
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
  if (hour === undefined || hour < REDRAW_HOUR || hour >= REDRAW_HOUR + REDRAW_WINDOW_HOURS) {
    return false;
  }
  return lastRedrawAt === undefined || now - lastRedrawAt >= REDRAW_SPACING_MS;
}
