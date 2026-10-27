export interface CaptureParts {
  capturedAt: Date;
  /** `YYYY-MM-DD` in the place the photo was taken. */
  localDate: string;
  /** `YYYY-MM-DD HH:MM:SS`, stored as `timestamp without time zone`. */
  wallClock: string;
  /** `UTC` or an offset such as `+03:00`. */
  timezone: string;
}

const ISO_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EXIF_STAMP = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;

/**
 * The calendar date comes from the offset in the string, not from UTC. A photo taken at
 * 01:00 in UTC+3 is still that local day, even though UTC is the evening before.
 */
export function partsFromIso(iso: string): CaptureParts | null {
  const match = ISO_LOCAL.exec(iso.trim());
  if (!match) return null;
  const [, date, time, zone] = match;
  if (!date || !time || !zone) return null;
  const capturedAt = new Date(iso);
  if (Number.isNaN(capturedAt.getTime())) return null;
  return {
    capturedAt,
    localDate: date,
    wallClock: `${date} ${time}`,
    timezone: zone === 'Z' ? 'UTC' : zone,
  };
}

/**
 * EXIF `DateTimeOriginal` is wall-clock time with no zone. Prefer the EXIF offset, then the
 * offset the phone already sent with `capturedAt`.
 */
export function partsFromExif(
  stamp: string,
  offset: string | undefined,
  fallbackZone: string,
): CaptureParts | null {
  const match = EXIF_STAMP.exec(stamp.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute || !second) return null;
  const timezone = offset && OFFSET.test(offset) ? offset : fallbackZone || 'UTC';
  const localDate = `${year}-${month}-${day}`;
  const wallClock = `${localDate} ${hour}:${minute}:${second}`;
  const capturedAt = new Date(
    `${localDate}T${hour}:${minute}:${second}${timezone === 'UTC' ? 'Z' : timezone}`,
  );
  if (Number.isNaN(capturedAt.getTime())) return null;
  return { capturedAt, localDate, wallClock, timezone };
}
