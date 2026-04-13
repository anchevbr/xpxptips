// ─────────────────────────────────────────────────────────────────────────────
// report-generator.ts
//
// Uses OpenAI (with web search) to produce a brief Greek-language narrative
// explaining what went right and wrong during the reporting period.
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { PickRecord } from '../types';

const openai = new OpenAI({ apiKey: config.openai.apiKey, timeout: 90_000 });

/**
 * Generates a 3–5 sentence Greek-language narrative analysis for the period.
 * Uses web search so the model can recall specific match details.
 */
export async function generateNarrative(
  picks: PickRecord[],
  periodLabel: string
): Promise<string> {
  const resolved = picks.filter(p => p.outcome !== null && p.outcome !== 'void');
  if (resolved.length === 0) {
    return 'Δεν υπάρχουν επαρκή αποτελέσματα για σχολιασμό αυτή την περίοδο.';
  }

  const wins = resolved.filter(p => p.outcome === 'win');
  const losses = resolved.filter(p => p.outcome === 'loss');

  const summary = resolved
    .map(p => {
      const icon = p.outcome === 'win' ? '✅' : '❌';
      return `${icon} ${p.homeTeam} vs ${p.awayTeam} (${p.league}) — Πρόταση: "${p.finalPick}", Αποτέλεσμα: ${p.actualScore ?? '?'}`;
    })
    .join('\n');

  const prompt =
    `Είσαι αθλητικός αναλυτής για κανάλι στοιχημάτων στο Telegram. ` +
    `Για την περίοδο ${periodLabel} είχαμε τα εξής αποτελέσματα:\n\n${summary}\n\n` +
    `Νίκες: ${wins.length} | Ήττες: ${losses.length}\n\n` +
    `Γράψε έναν σύντομο σχολιασμό 3–5 προτάσεων στα ελληνικά που:\n` +
    `1. Αναφέρει τι πήγε καλά (ποιες αναλύσεις ήταν σωστές και γιατί)\n` +
    `2. Εξηγεί τυχόν ήττες (τι πήγε στραβά, χωρίς δικαιολογίες)\n` +
    `3. Κλείνει με μια παρακινητική πρόταση για την επόμενη εβδομάδα\n` +
    `Γράψε ΜΟΝΟ τον σχολιασμό, χωρίς τίτλο ή εισαγωγή.`;

  try {
    const resp = await openai.responses.create({
      model: config.openai.model,
      input: prompt,
      tools: [{ type: 'web_search_preview' }],
    } as Parameters<typeof openai.responses.create>[0]);

    const text = (resp as { output_text?: string }).output_text ?? '';
    return text.trim() || 'Σχολιασμός δεν ήταν διαθέσιμος.';
  } catch (err) {
    logger.warn(`[report-generator] narrative failed: ${String(err)}`);
    return 'Σχολιασμός δεν ήταν διαθέσιμος λόγω τεχνικού προβλήματος.';
  }
}
