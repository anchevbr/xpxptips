// ─────────────────────────────────────────────────────────────────────────────
// fulltime/narrator.ts
//
// Uses GPT with web search to produce a Greek-language full-time commentary.
// If the tip won: celebrates with key stats that helped.
// If the tip lost: explains why with the stats/events that prevented the win.
// ─────────────────────────────────────────────────────────────────────────────

import {
  formatCommentaryLineupBlock,
  formatCommentaryStatsBlock,
  runCommentaryPrompt,
} from '../utils/commentary';
import type { PickRecord } from '../types';
import type { EventStat, LineupPlayer } from '../halftime/stats-fetcher';

/**
 * Generates a Greek full-time commentary using GPT + web search.
 *
 * @param pick       The PickRecord with market/pick info
 * @param homeScore  Final home score
 * @param awayScore  Final away score
 * @param outcome    'win' | 'loss' | 'push'
 * @param stats      Full-time stats from the live-data provider
 * @param lineup     Player lineup (optional)
 */
export async function generateFulltimeNarrative(
  pick: PickRecord,
  homeScore: number | null,
  awayScore: number | null,
  outcome: 'win' | 'loss' | 'push',
  stats: EventStat[],
  lineup: LineupPlayer[] = []
): Promise<string> {
  const scoreStr =
    homeScore !== null && awayScore !== null ? `${homeScore}–${awayScore}` : 'Άγνωστο';
  const preMatchReasoning = pick.preMatchReasoning?.trim() || 'Δεν διασώθηκε η αρχική prematch λογική μας.';

  const statsBlock = formatCommentaryStatsBlock(stats);
  const lineupBlock = formatCommentaryLineupBlock(lineup, pick.homeTeam, pick.awayTeam);

  const matchDate = pick.date;

  const outcomeInstruction =
    outcome === 'win'
      ? `Η πρόταση ΚΕΡΔΙΣΕ. Γράψε 2–3 σύντομες προτάσεις με θετική ενέργεια. ` +
        `Σύνδεσε ρητά την αρχική prematch ιδέα με ό,τι επιβεβαιώθηκε στο γήπεδο. ` +
        `Ανέφερε έναν-δύο παίκτες ή κομβικά στατιστικά που δικαίωσαν το διάβασμά μας.`
      : outcome === 'loss'
      ? `Η πρόταση ΕΧΑΣΕ. Γράψε 2–3 σύντομες προτάσεις. ` +
        `Ξεκίνα από το τι περιμέναμε pre-match και πες καθαρά ποιο κομμάτι δεν βγήκε. ` +
        `Μόνο γιατί χάθηκε και τέλος. ΜΗΝ γράψεις τίποτα για το πώς ίσως μπορούσε να εξελιχθεί αλλιώς το ματς.`
      : `Η πρόταση επέστρεψε (push). Γράψε 2–3 σύντομες προτάσεις που εξηγούν τι περιμέναμε και γιατί τελικά το ματς έκλεισε ακριβώς στο όριο.`;

  const prompt =
    `Είσαι αθλητικός αναλυτής για κανάλι στοιχημάτων στο Telegram. ` +
    `Κάνε web search ΜΟΝΟ για τον αγώνα που έπαιξε ΣΗΜΕΡΑ, ${matchDate}: ` +
    `"${pick.homeTeam} vs ${pick.awayTeam}" στις ${matchDate}. ` +
    `ΜΗΝ χρησιμοποιείς αποτελέσματα από προηγούμενα ή μελλοντικά παιχνίδια τους. ` +
    `Ψάχνεις στατιστικά παικτών από ΑΥΤΟ το ματς (γκολ, ασίστ, πόντοι, ριμπάουντ κτλ.) ` +
    `και σημαντικά γεγονότα (γκολ, κόκκινες κάρτες, τραυματισμοί, αποφασιστικές στιγμές).\n\n` +
    `📋 ΣΤΟΙΧΕΙΑ ΑΓΩΝΑ:\n` +
    `Αγώνας: ${pick.homeTeam} vs ${pick.awayTeam} (${pick.league})\n` +
    `Ημερομηνία: ${matchDate}\n` +
    `Πρόταση: "${pick.finalPick}" (market: ${pick.bestBettingMarket})\n` +
    `Τελικό σκορ: ${scoreStr}\n` +
    `Αποτέλεσμα πρότασης: ${outcome === 'win' ? '✅ ΚΕΡΔΙΣΕ' : outcome === 'loss' ? '❌ ΕΧΑΣΕ' : '↩️ PUSH'}\n\n` +
    `🧠 ΑΡΧΙΚΗ PRE-MATCH ΛΟΓΙΚΗ:\n${preMatchReasoning}\n\n` +
    `📊 ΣΤΑΤΙΣΤΙΚΑ ΑΓΩΝΑ:\n${statsBlock}\n\n` +
    (lineupBlock ? `👥 ΕΝΔΕΚΑΔΕΣ:\n${lineupBlock}\n\n` : '') +
    `📝 ΟΔΗΓΙΕΣ:\n` +
    `Γράψε ακριβώς 3–4 προτάσεις στα ελληνικά. ${outcomeInstruction}\n` +
    `Μόνο το κείμενο. Χωρίς τίτλο, χωρίς bullets. Χωρίς links, domains ή παραπομπές σε πηγές.`;

  return runCommentaryPrompt({
    scope: 'fulltime-commentary',
    logLabel: 'fulltime-narrator',
    prompt,
    usageMeta: {
      fixtureId: pick.fixtureId,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
      league: pick.league,
      outcome,
    },
    emptyFallbackText: 'Σχολιασμός τελικού αποτελέσματος δεν ήταν διαθέσιμος.',
    errorFallbackText: 'Σχολιασμός τελικού αποτελέσματος δεν ήταν διαθέσιμος λόγω τεχνικού προβλήματος.',
  });
}
