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
    logChatId: optional('TELEGRAM_LOG_CHAT_ID', ''),
    logLevel: optional('TELEGRAM_LOG_LEVEL', 'info'),
    logBatchMs: optionalNumber('TELEGRAM_LOG_BATCH_MS', 15_000),
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: optional('OPENAI_MODEL', 'gpt-5.4'),
    /** Optional override for the live web-search context fetch before expert analysis */
    liveContextModel: optional('OPENAI_LIVE_CONTEXT_MODEL', optional('OPENAI_MODEL', 'gpt-5.4')),
    /** Model used by halftime/full-time live commentary updates */
    commentaryModel: optional('OPENAI_COMMENTARY_MODEL', 'gpt-5.4'),
    /** Model used by weekly/monthly report narratives */
    reportModel: optional('OPENAI_REPORT_MODEL', 'gpt-5.4'),
    /** Reasoning effort for halftime/full-time commentary calls */
    commentaryEffort: optional('OPENAI_COMMENTARY_EFFORT', 'high') as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh',
    /** Reasoning effort for weekly/monthly report narrative calls */
    reportEffort: optional('OPENAI_REPORT_EFFORT', 'high') as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh',
    /** Reasoning effort for the live web-search context fetch before expert analysis */
    liveContextEffort: optional('OPENAI_LIVE_CONTEXT_EFFORT', 'medium') as
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
    /** Per-call timeout in milliseconds. Set to 0 to disable the client-side cap. */
    timeoutMs: optionalNumber('OPENAI_TIMEOUT_MS', 90_000),
  },

  sports: {
    /** Optional API-Sports key used for API-FOOTBALL / API-BASKETBALL live polling and result resolution. */
    apiSportsKey: optional('APISPORTS_API_KEY', optional('API_SPORTS_API_KEY', '')),
    /** API-Sports request timeout in milliseconds. Set to 0 to disable the client-side cap. */
    apiSportsTimeoutMs: optionalNumber('APISPORTS_TIMEOUT_MS', 10_000),
  },

  scheduler: {
    /** Cron that runs nightly to plan the next day's fixture posts (default: 03:00 in TIMEZONE) */
    planningCron: optional('PLANNING_CRON', '0 3 * * *'),
    timezone: optional('TIMEZONE', 'Europe/Athens'),
    /** How many hours before kickoff to run analysis and send immediately if approved (default: 4) */
    analysisHoursBeforeKickoff: optionalNumber('ANALYSIS_HOURS_BEFORE_KICKOFF', 4),
  },

  analysis: {
    minConfidenceToPublish: optionalNumber('MIN_CONFIDENCE_TO_PUBLISH', 6),
    maxTipsPerDay: optionalNumber('MAX_TIPS_PER_DAY', 5),
    /** Minimum acceptable odds — tips below this threshold are rejected (default: 1.50) */
    minAcceptableOdds: optionalNumber('MIN_ACCEPTABLE_ODDS', 1.50),
    /**
     * TEST MODE — bypasses the scheduled-status check, Gate 5 (odds), and dedup.
     * Set FORCE_ANALYSIS=true in .env to push every fixture through the full
     * expert-analysis and publication path regardless of fixture status or
     * whether markets are available. NEVER set this in production.
     */
    forceAnalysis: optionalBool('FORCE_ANALYSIS', false),
  },

  db: {
    path: optional('DB_PATH', './data/posted.db'),
  },

  logLevel: optional('LOG_LEVEL', 'info'),
} as const;
