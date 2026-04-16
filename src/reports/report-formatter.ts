// ─────────────────────────────────────────────────────────────────────────────
// report-formatter.ts
//
// Formats pick records into a beautifully structured HTML Telegram message.
// Uses Greek language throughout to match the channel's voice.
// ─────────────────────────────────────────────────────────────────────────────

import type { PickRecord, Competition } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SPORT_EMOJI: Record<Competition | string, string> = {
  football: '⚽',
  EuroLeague: '🏀',
  NBA: '🏀',
  other: '🏆',
};

function sportEmoji(pick: PickRecord): string {
  // Derive sport from bestBettingMarket or league name fallback
  if (pick.league.toLowerCase().includes('euro') || pick.league.toLowerCase().includes('nba')) {
    return pick.league.toLowerCase().includes('nba') ? '🏀' : '🏀';
  }
  // If it has btts it's football
  if (pick.bestBettingMarket.startsWith('btts')) return '⚽';
  return SPORT_EMOJI[pick.league] ?? '⚽';
}

function outcomeIcon(outcome: PickRecord['outcome']): string {
  if (outcome === 'win') return '✅';
  if (outcome === 'loss') return '❌';
  if (outcome === 'void') return '↩️';
  return '⏳';
}

function outcomeLabel(outcome: PickRecord['outcome']): string {
  if (outcome === 'win') return 'Σωστό';
  if (outcome === 'loss') return 'Λάθος';
  if (outcome === 'void') return 'Επιστροφή';
  return 'Εκκρεμεί';
}

/**
 * Converts a YYYY-MM-DD date string to a Greek display label.
 * e.g. "2026-04-07" → "7 Απρ"
 */
function formatDateGreek(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('el-GR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Athens',
  });
}

/**
 * Formats a date range like "7–13 Απριλίου 2026"
 */
export function formatDateRange(from: string, to: string): string {
  const fromDate = new Date(from + 'T12:00:00Z');
  const toDate = new Date(to + 'T12:00:00Z');

  const fromDay = fromDate.toLocaleDateString('el-GR', {
    day: 'numeric',
    timeZone: 'Europe/Athens',
  });
  const toDay = toDate.toLocaleDateString('el-GR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Athens',
  });

  return `${fromDay}–${toDay}`;
}

/**
 * Formats a month label like "Απρίλιος 2026"
 */
export function formatMonthGreek(yyyy: number, mm: number): string {
  const d = new Date(yyyy, mm - 1, 1);
  return d.toLocaleDateString('el-GR', { month: 'long', year: 'numeric' });
}

const DIVIDER = '──────────────────────────────';

/**
 * Renders the list of picks as HTML lines for the Telegram message.
 */
function renderPickLines(picks: PickRecord[]): string {
  if (picks.length === 0) return '<i>Δεν υπάρχουν picks αυτή την περίοδο.</i>';

  return picks
    .map(p => {
      const emoji = sportEmoji(p);
      const score = p.actualScore ? `<b>${p.actualScore}</b>` : '<i>εκκρεμεί</i>';
      const icon = outcomeIcon(p.outcome);
      const label = outcomeLabel(p.outcome);
      const date = formatDateGreek(p.date);
      return (
        `${emoji} <b>${p.homeTeam} – ${p.awayTeam}</b> <i>(${date})</i>\n` +
        `├ 📌 Πρόταση: <b>${p.finalPick}</b>\n` +
        `├ 📊 Αποτέλεσμα: ${score}\n` +
        `└ ${icon} ${label}`
      );
    })
    .join('\n\n');
}

/**
 * Renders the stats summary line.
 */
function renderStats(picks: PickRecord[]): string {
  const resolved = picks.filter(p => p.outcome !== null && p.outcome !== 'void');
  const wins = resolved.filter(p => p.outcome === 'win').length;
  const total = resolved.length;
  const pct = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
  const voids = picks.filter(p => p.outcome === 'void').length;
  const pending = picks.filter(p => p.outcome === null).length;

  let line = `📈 <b>Αποτελέσματα: ${wins}/${total} — ${pct}%</b>`;
  if (voids > 0) line += ` | ↩️ ${voids}`;
  if (pending > 0) line += ` | ⏳ ${pending} εκκρεμεί`;
  return line;
}

// ─── Public formatters ────────────────────────────────────────────────────────

/**
 * Builds the full weekly report Telegram message (HTML).
 */
export function formatWeeklyReport(
  picks: PickRecord[],
  weekFrom: string,
  weekTo: string,
  narrative: string
): string {
  const dateRange = formatDateRange(weekFrom, weekTo);
  const lines: string[] = [
    `📊 <b>Εβδομαδιαία Αναφορά</b>`,
    `📅 <i>${dateRange}</i>`,
    DIVIDER,
    renderPickLines(picks),
    DIVIDER,
    renderStats(picks),
    DIVIDER,
    `🔍 <b>Σχολιασμός Εβδομάδας</b>`,
    `<i>${narrative}</i>`,
  ];
  return lines.join('\n');
}

/**
 * Builds the full monthly report Telegram message (HTML).
 */
export function formatMonthlyReport(
  picks: PickRecord[],
  yyyy: number,
  mm: number,
  narrative: string
): string {
  const monthLabel = formatMonthGreek(yyyy, mm);
  const lines: string[] = [
    `📅 <b>Μηνιαία Αναφορά — ${monthLabel}</b>`,
    DIVIDER,
    renderPickLines(picks),
    DIVIDER,
    renderStats(picks),
    DIVIDER,
    `🔍 <b>Σχολιασμός Μήνα</b>`,
    `<i>${narrative}</i>`,
  ];
  return lines.join('\n');
}
