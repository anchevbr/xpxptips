// ─────────────────────────────────────────────────────────────────────────────
// fulltime/narrator.ts
//
// Uses GPT with web search to produce a Greek-language full-time commentary.
// If the tip won: celebrates with key stats that helped.
// If the tip lost: explains why with the stats/events that prevented the win.
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../config';
import { logger } from '../utils/logger';
import { createOpenAIClient } from '../utils/openai-client';
import { extractResponseOutputText, runResponseWithActivityLogging } from '../utils/openai-activity';
import type { PickRecord } from '../types';
import type { EventStat, LineupPlayer } from '../halftime/stats-fetcher';

const openai = createOpenAIClient();

function formatStatsBlock(stats: EventStat[]): string {
  if (stats.length === 0) return 'Δεν υπάρχουν διαθέσιμα στατιστικά.';
  return stats
    .map(s => `  ${s.strStat}: ${s.intHome} – ${s.intAway} (γηπεδούχοι – φιλοξενούμενοι)`)
    .join('\n');
}

function formatLineupBlock(lineup: LineupPlayer[], homeTeam: string, awayTeam: string): string {
  if (lineup.length === 0) return '';
  const starters = lineup.filter(p => p.strSubstitute === 'No');
  const homePlayers = starters.filter(p => p.strHome === 'Yes').map(p => p.strPlayer).join(', ');
  const awayPlayers = starters.filter(p => p.strHome === 'No').map(p => p.strPlayer).join(', ');
  return `Ενδεκάδα ${homeTeam}: ${homePlayers}\nΕνδεκάδα ${awayTeam}: ${awayPlayers}`;
}

/**
 * Generates a Greek full-time commentary using GPT + web search.
 *
 * @param pick       The PickRecord with market/pick info
 * @param homeScore  Final home score
 * @param awayScore  Final away score
 * @param outcome    'win' | 'loss' | 'push'
 * @param stats      Full-time stats from TheSportsDB
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
  const model = config.openai.commentaryModel;
  const scoreStr =
    homeScore !== null && awayScore !== null ? `${homeScore}–${awayScore}` : 'Άγνωστο';

  const statsBlock = formatStatsBlock(stats);
  const lineupBlock = formatLineupBlock(lineup, pick.homeTeam, pick.awayTeam);

  const matchDate = pick.date;

  const outcomeInstruction =
    outcome === 'win'
      ? `Η πρόταση ΚΕΡΔΙΣΕ! Γράψε χαρούμενο, ενθουσιώδες κείμενο. ` +
        `Εξήγησε γιατί κέρδισε, τι πήγε καλά. Ανέφερε έναν-δύο παίκτες που ξεχώρισαν στο ματς. ` +
        `Κλείσε με κάτι σαν "Συγχαρητήρια σε όσους ήταν μαζί μας!" ή παρόμοιο.`
      : outcome === 'loss'
      ? `Η πρόταση ΕΧΑΣΕ. Γράψε ειλικρινές, αναλυτικό κείμενο. ` +
        `Εξήγησε γιατί χάθηκε: ποια στατιστικά ή γεγονότα δεν πήγαν όπως ανέμεναμε. ` +
        `Ανέφερε έναν-δύο παίκτες ή στιγμές του ματς που επηρέασαν το αποτέλεσμα. ` +
        `Χωρίς δραματισμό — αντικειμενικό post-mortem. Κλείσε με κάτι συνοπτικό όπως "Τα πράγματα δεν πήγαν όπως αναλύσαμε και συνεχίζουμε." `
      : /* push */ `Η πρόταση επέστρεψε (push — ακριβώς στο όριο). Εξήγησε τι έγινε και γιατί.`;

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
    `📊 ΣΤΑΤΙΣΤΙΚΑ ΑΓΩΝΑ:\n${statsBlock}\n\n` +
    (lineupBlock ? `👥 ΕΝΔΕΚΑΔΕΣ:\n${lineupBlock}\n\n` : '') +
    `📝 ΟΔΗΓΙΕΣ:\n` +
    `Γράψε ακριβώς 3–4 προτάσεις στα ελληνικά. ${outcomeInstruction}\n` +
    `Μόνο το κείμενο. Χωρίς τίτλο, χωρίς bullets. Χωρίς links ή παραπομπές σε πηγές.`;

  try {
    const resp = await runResponseWithActivityLogging({
      client: openai,
      scope: 'fulltime-commentary',
      model,
      timeoutMs: config.openai.timeoutMs,
      usageMeta: {
        fixtureId: pick.fixtureId,
        homeTeam: pick.homeTeam,
        awayTeam: pick.awayTeam,
        league: pick.league,
        outcome,
      },
      params: {
        model,
        input: prompt,
        reasoning: { effort: config.openai.commentaryEffort },
        tools: [{ type: 'web_search_preview' }],
      } as Parameters<typeof openai.responses.stream>[0],
    });

    const raw = extractResponseOutputText(resp);
    const text = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    return text || 'Σχολιασμός τελικού αποτελέσματος δεν ήταν διαθέσιμος.';
  } catch (err) {
    logger.warn(`[fulltime-narrator] GPT call failed: ${String(err)}`);
    return 'Σχολιασμός τελικού αποτελέσματος δεν ήταν διαθέσιμος λόγω τεχνικού προβλήματος.';
  }
}
