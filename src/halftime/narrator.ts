// ─────────────────────────────────────────────────────────────────────────────
// halftime/narrator.ts
//
// Uses GPT with web search to produce a Greek-language halftime commentary.
// Assesses the tip status, highlights key player performances, and advises
// users whether to stay in or consider withdrawing the bet.
// ─────────────────────────────────────────────────────────────────────────────

import { config } from '../config';
import { logger } from '../utils/logger';
import { createOpenAIClient } from '../utils/openai-client';
import { extractResponseOutputText, runResponseWithActivityLogging } from '../utils/openai-activity';
import { assessHalftimeTipState, halftimeStatusLabel } from './tip-state';
import { sanitizeCommentaryText } from '../utils/commentary';
import type { PickRecord } from '../types';
import type { EventStat, LineupPlayer } from './stats-fetcher';

const openai = createOpenAIClient();

/** Formats team stats into a readable table for the prompt */
function formatStatsBlock(stats: EventStat[]): string {
  if (stats.length === 0) return 'Δεν υπάρχουν διαθέσιμα στατιστικά.';
  return stats
    .map(s => `  ${s.strStat}: ${s.intHome} – ${s.intAway} (γηπεδούχοι – φιλοξενούμενοι)`)
    .join('\n');
}

/** Formats lineup into a compact string per team */
function formatLineupBlock(lineup: LineupPlayer[], homeTeam: string, awayTeam: string): string {
  if (lineup.length === 0) return '';
  const starters = lineup.filter(p => p.strSubstitute === 'No');
  const homePlayers = starters.filter(p => p.strHome === 'Yes').map(p => p.strPlayer).join(', ');
  const awayPlayers = starters.filter(p => p.strHome === 'No').map(p => p.strPlayer).join(', ');
  return `Ενδεκάδα ${homeTeam}: ${homePlayers}\nΕνδεκάδα ${awayTeam}: ${awayPlayers}`;
}

/**
 * Generates a Greek halftime commentary using GPT + web search.
 * - Mentions specific player performances found via web search
 * - Assesses if the tip is on track, at risk, or already lost
 * - Suggests withdrawal ONLY when 99% certain the tip cannot win
 * - States clearly if the tip is already lost and why
 *
 * @param pick        The published PickRecord
 * @param homeScore   HT home score (null if unknown)
 * @param awayScore   HT away score (null if unknown)
 * @param stats       Team stats from TheSportsDB
 * @param lineup      Player lineup from TheSportsDB (optional)
 */
export async function generateHalftimeNarrative(
  pick: PickRecord,
  homeScore: number | null,
  awayScore: number | null,
  stats: EventStat[],
  lineup: LineupPlayer[] = []
): Promise<string> {
  const model = config.openai.commentaryModel;
  const scoreStr =
    homeScore !== null && awayScore !== null ? `${homeScore}–${awayScore}` : 'Άγνωστο';
  const halftimeState = assessHalftimeTipState(pick, homeScore, awayScore);
  const preMatchReasoning = pick.preMatchReasoning?.trim() || 'Δεν διασώθηκε η αρχική prematch λογική μας.';

  const statsBlock = formatStatsBlock(stats);
  const lineupBlock = formatLineupBlock(lineup, pick.homeTeam, pick.awayTeam);

  const matchDate = pick.date; // YYYY-MM-DD
  const stateInstruction =
    halftimeState === 'lost'
      ? `Η πρόταση έχει ουσιαστικά χαθεί ήδη από το ημίχρονο. Γράψε 2–3 σύντομες προτάσεις. ` +
        `Πες ξεκάθαρα τι περιμέναμε πριν το ματς, τι δεν συνέβη και γιατί χάθηκε ήδη. ` +
        `ΜΗΝ γράψεις τίποτα για το πώς μπορεί να κυλήσει το β' ημίχρονο ή τι ίσως γίνει από εδώ και πέρα.`
      : halftimeState === 'won'
      ? `Η πρόταση έχει ήδη επιβεβαιωθεί από το ημίχρονο. Γράψε 2–3 σύντομες προτάσεις με θετική ενέργεια. ` +
        `Σύνδεσε ρητά την αρχική prematch ιδέα με ό,τι επιβεβαιώθηκε ήδη μέσα στο ματς.`
      : `Γράψε 3 σύντομες προτάσεις που πατούν πάνω στην αρχική μας ανάλυση: τι περιμέναμε pre-match και τι βλέπουμε τώρα. ` +
        `Αν η εικόνα είναι αρνητική, πες το καθαρά χωρίς να παρουσιάσεις την πρόταση σαν χαμένη αν δεν έχει κριθεί ήδη.`;

  const prompt =
    `Είσαι αθλητικός αναλυτής για κανάλι στοιχημάτων στο Telegram. ` +
    `Κάνε web search ΜΟΝΟ για τον αγώνα που παίζεται ΣΗΜΕΡΑ, ${matchDate}: ` +
    `"${pick.homeTeam} vs ${pick.awayTeam}" στις ${matchDate}. ` +
    `ΜΗΝ χρησιμοποιείς αποτελέσματα από προηγούμενα ή μελλοντικά παιχνίδια τους. ` +
    `Ψάχνεις στατιστικά παικτών από ΑΥΤΟ το ζωντανό ματς (γκολ, ασίστ, πόντοι, ριμπάουντ κτλ.) ` +
    `ή σημαντικά γεγονότα του ημιχρόνου (κόκκινη κάρτα, τραυματισμός κτλ.).\n\n` +
    `📋 ΣΤΟΙΧΕΙΑ ΑΓΩΝΑ:\n` +
    `Αγώνας: ${pick.homeTeam} vs ${pick.awayTeam} (${pick.league})\n` +
    `Ημερομηνία: ${matchDate}\n` +
    `Πρόταση: "${pick.finalPick}" (market: ${pick.bestBettingMarket})\n` +
    `Σκορ Ημιχρόνου: ${scoreStr}\n\n` +
    `🧠 ΑΡΧΙΚΗ PRE-MATCH ΛΟΓΙΚΗ:\n${preMatchReasoning}\n\n` +
    `📍 ΚΑΤΑΣΤΑΣΗ ΣΤΟ ΗΜΙΧΡΟΝΟ: ${halftimeStatusLabel(halftimeState)}\n\n` +
    `📊 ΣΤΑΤΙΣΤΙΚΑ ΗΜΙΧΡΟΝΟΥ:\n${statsBlock}\n\n` +
    (lineupBlock ? `👥 ΕΝΔΕΚΑΔΕΣ:\n${lineupBlock}\n\n` : '') +
    `📝 ΟΔΗΓΙΕΣ:\n` +
    `${stateInstruction}\n` +
    `Αν βάλεις ονόματα παικτών ή match events, να είναι από ΑΥΤΟ το ματς σήμερα.\n` +
    `1. Αναφέρουν έναν ή δύο συγκεκριμένους παίκτες με στατιστικά ΑΠΟ ΑΥΤΟ ΤΟ ΜΑΤΣ σήμερα (πχ "Ο Σλούκας έχει 12 πόντους", "Ο Ρονάλντο έχει σκοράρει"). Αν δεν βρεις στατιστικά παικτών για το συγκεκριμένο ματς, αναφέρεις το πιο λαμπρό στατιστικό ομάδας από τα παραπάνω δεδομένα.\n` +
    `2. Να δείχνουν αν επιβεβαιώθηκε ή διαψεύστηκε η αρχική μας ιδέα μέχρι στιγμής.\n` +
    `3. ΑΝ η πρόταση είναι ήδη χαμένη: πες ξεκάθαρα τον λόγο και σταμάτα εκεί. Όχι future outlook.\n` +
    `Μόνο το κείμενο. Χωρίς τίτλο, χωρίς bullets. Χωρίς links, domains ή παραπομπές σε πηγές.`;

  try {
    const resp = await runResponseWithActivityLogging({
      client: openai,
      scope: 'halftime-commentary',
      model,
      timeoutMs: config.openai.timeoutMs,
      usageMeta: {
        fixtureId: pick.fixtureId,
        homeTeam: pick.homeTeam,
        awayTeam: pick.awayTeam,
        league: pick.league,
      },
      params: {
        model,
        input: prompt,
        reasoning: { effort: config.openai.commentaryEffort },
        tools: [{ type: 'web_search_preview' }],
      } as Parameters<typeof openai.responses.stream>[0],
    });

    const raw = extractResponseOutputText(resp);
    const text = sanitizeCommentaryText(raw);
    return text || 'Σχολιασμός ημιχρόνου δεν ήταν διαθέσιμος.';
  } catch (err) {
    logger.warn(`[halftime-narrator] GPT call failed: ${String(err)}`);
    return 'Σχολιασμός ημιχρόνου δεν ήταν διαθέσιμος λόγω τεχνικού προβλήματος.';
  }
}
