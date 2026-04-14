// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema definitions for structured OpenAI Responses API output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for the full expert betting analysis phase.
 * Pass isSoccer=true for football, false for basketball — adjusts market/pick descriptions.
 */
export function buildExpertAnalysisSchema(isSoccer: boolean) {
  return {
    type: 'object',
    properties: {
      event: { type: 'string' },
      competition: { type: 'string' },
      date: { type: 'string' },
      homeTeam: { type: 'string' },
      awayTeam: { type: 'string' },
      keyFacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Confirmed facts that influence the analysis (do not invent). Prefer high-signal facts in Greek: absences, tactical changes, aggregate context, motivation, coach/team news, and only the most relevant stats/odds.',
      },
      riskFactors: {
        type: 'array',
        items: { type: 'string' },
        description: 'Risks or uncertainties in Greek that could invalidate the pick. Include non-numeric risks when relevant: rotation, morale, tactical uncertainty, coach decisions, game-state management, late team news.',
      },
      bestBettingMarket: {
        type: 'string',
        enum: isSoccer
          ? ['h2h/home', 'h2h/draw', 'h2h/away', 'totals/over', 'totals/under', 'btts/yes', 'btts/no']
          : ['h2h/home', 'h2h/away', 'totals/over', 'totals/under'],
        description: isSoccer
          ? 'Machine-readable market token — pick exactly one. "h2h/home"=home team wins, "h2h/draw"=draw, "h2h/away"=away team wins, "totals/over"=over the line, "totals/under"=under the line, "btts/yes"=both teams score, "btts/no"=clean sheet.'
          : 'Machine-readable market token — pick exactly one. "h2h/home"=home team wins, "h2h/away"=away team wins, "totals/over"=over the line, "totals/under"=under the line. No draw, no BTTS in basketball.',
      },
      finalPick: {
        type: 'string',
        description: isSoccer
          ? 'Short betting shorthand in Greek/common notation: "Άσσος" (home win), "Ισοπαλία" (draw), "Διπλό" (away win), "X2" (draw or away), "1X" (home or draw), "G/G" (BTTS Yes), "Over 2.5", "Under 2.5". Max 4 words.'
          : 'Short betting shorthand — basketball ONLY. Examples: "Νίκη [HomeTeam]" (home win), "Νίκη [AwayTeam]" (away win), "Over [line]", "Under [line]". NEVER use "Ισοπαλία", "Draw", "X2", "1X", "G/G" — these do not exist in basketball. Max 4 words.',
      },
      confidence: {
        type: 'number',
        description: 'Analyst confidence from 1 (very uncertain) to 10 (very confident)',
      },
      shortReasoning: {
        type: 'string',
        description: '2–4 sentence compact reasoning in Greek that naturally blends the key numeric and qualitative context into one short betting note',
      },
      dataQualityNote: {
        type: 'string',
        description: 'Note on the quality and completeness of available data',
      },
      isPickRecommended: {
        type: 'boolean',
        description: 'Set to false if data is insufficient to make a responsible recommendation',
      },
      noPickReason: {
        type: 'string',
        description: 'When isPickRecommended is false, explain why. Otherwise empty string.',
      },
    },
    required: [
      'event',
      'competition',
      'date',
      'homeTeam',
      'awayTeam',
      'keyFacts',
      'riskFactors',
      'bestBettingMarket',
      'finalPick',
      'confidence',
      'shortReasoning',
      'dataQualityNote',
      'isPickRecommended',
      'noPickReason',
    ],
    additionalProperties: false,
  } as const;
}
