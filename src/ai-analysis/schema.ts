// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema definitions for structured OpenAI Responses API output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for the fast screening phase.
 * The model returns a scored list of fixture IDs with reasons.
 */
export const screeningSchema = {
  type: 'object',
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fixtureId: { type: 'string' },
          interestScore: {
            type: 'number',
            description: 'Betting interest score from 0 (no value) to 10 (exceptional opportunity)',
          },
          dataQuality: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
          },
          reasons: {
            type: 'array',
            items: { type: 'string' },
            description: 'Short bullet reasons explaining the interest score',
          },
          shouldAnalyze: {
            type: 'boolean',
            description: 'Whether this fixture should be passed to the deep expert analysis phase',
          },
        },
        required: ['fixtureId', 'interestScore', 'dataQuality', 'reasons', 'shouldAnalyze'],
        additionalProperties: false,
      },
    },
  },
  required: ['assessments'],
  additionalProperties: false,
} as const;

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
        description: 'Confirmed facts that influence the analysis (do not invent)',
      },
      riskFactors: {
        type: 'array',
        items: { type: 'string' },
        description: 'Risks or uncertainties that could invalidate the pick',
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
        description: '2–4 sentence concise reasoning for the pick',
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
