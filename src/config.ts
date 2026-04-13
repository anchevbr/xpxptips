import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val.toLowerCase() === 'true';
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    groupChatId: required('TELEGRAM_GROUP_CHAT_ID'),
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.4'),
    /** Reasoning effort for the fast screening pass */
    screeningEffort: optional('OPENAI_SCREENING_EFFORT', 'medium') as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh',
    /** Reasoning effort for the final expert betting analysis */
    expertEffort: optional('OPENAI_EXPERT_EFFORT', 'high') as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh',
    /** Per-call timeout in milliseconds — skips fixture on expiry */
    timeoutMs: optionalNumber('OPENAI_TIMEOUT_MS', 90_000),
  },

  scheduler: {
    /** Cron that runs nightly to plan the next day's fixture posts (default: 2am UTC) */
    planningCron: optional('PLANNING_CRON', '0 2 * * *'),
    timezone: optional('TIMEZONE', 'Europe/Athens'),
    /** How many hours before a fixture's kickoff to send the analysis (default: 8) */
    hoursBeforeKickoff: optionalNumber('HOURS_BEFORE_KICKOFF', 8),
  },

  analysis: {
    minInterestScore: optionalNumber('MIN_INTEREST_SCORE', 5),
    minConfidenceToPublish: optionalNumber('MIN_CONFIDENCE_TO_PUBLISH', 6),
    maxTipsPerDay: optionalNumber('MAX_TIPS_PER_DAY', 5),
    /** Maximum fixtures forwarded from screening to deep expert analysis */
    maxCandidatesFromScreening: optionalNumber('MAX_CANDIDATES_FROM_SCREENING', 10),
    /** Minimum acceptable odds — tips below this threshold are rejected (default: 1.50) */
    minAcceptableOdds: optionalNumber('MIN_ACCEPTABLE_ODDS', 1.50),
    /**
     * TEST MODE — bypass screening filter, Gate 5 (odds), and dedup.
     * Set FORCE_ANALYSIS=true in .env to push every fixture through the full
     * expert-analysis and publication path regardless of screening scores or
     * whether markets are available. NEVER set this in production.
     */
    forceAnalysis: optionalBool('FORCE_ANALYSIS', false),
  },

  db: {
    path: optional('DB_PATH', './data/posted.db'),
  },

  logLevel: optional('LOG_LEVEL', 'info'),
} as const;
