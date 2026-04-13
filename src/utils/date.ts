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
