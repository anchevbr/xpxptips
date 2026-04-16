/**
 * Returns today's date as YYYY-MM-DD in UTC.
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns tomorrow's date as YYYY-MM-DD in UTC.
 */
export function tomorrowUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function getDatePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const day = Number(parts.find(part => part.type === 'day')?.value);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Unable to resolve calendar date for time zone "${timeZone}"`);
  }

  return { year, month, day };
}

/**
 * Returns a calendar date as YYYY-MM-DD in the provided time zone.
 */
export function dateOffsetInTimeZone(timeZone: string, offsetDays = 0, baseDate = new Date()): string {
  const { year, month, day } = getDatePartsInTimeZone(baseDate, timeZone);
  const normalized = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return normalized.toISOString().slice(0, 10);
}

/**
 * Returns today's date as YYYY-MM-DD in the provided time zone.
 */
export function todayInTimeZone(timeZone: string): string {
  return dateOffsetInTimeZone(timeZone, 0);
}

/**
 * Returns tomorrow's date as YYYY-MM-DD in the provided time zone.
 */
export function tomorrowInTimeZone(timeZone: string): string {
  return dateOffsetInTimeZone(timeZone, 1);
}

/**
 * Returns yesterday's date as YYYY-MM-DD in the provided time zone.
 */
export function yesterdayInTimeZone(timeZone: string): string {
  return dateOffsetInTimeZone(timeZone, -1);
}

/**
 * Formats an ISO datetime string to Athens, Greece local time.
 * Returns format: "Τρίτη 16 Απριλίου, 22:00" (Greek day/month/time)
 */
export function formatAthensDateTime(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  
  // Format: "Τρίτη 16 Απριλίου, 22:00"
  const dayMonth = date.toLocaleDateString('el-GR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Athens',
  });
  
  const time = date.toLocaleTimeString('el-GR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Athens',
  });
  
  return `${dayMonth}, ${time}`;
}

/**
 * Formats an ISO datetime string to Athens time in compact format.
 * Returns format: "16/04 22:00" (for logs/compact display)
 */
export function formatAthensDateTimeCompact(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  
  const dateStr = date.toLocaleDateString('el-GR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Athens',
  });
  
  const time = date.toLocaleTimeString('el-GR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Athens',
  });
  
  return `${dateStr} ${time}`;
}
