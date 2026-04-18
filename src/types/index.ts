// ─────────────────────────────────────────────────────────────────────────────
// Central type definitions
// ─────────────────────────────────────────────────────────────────────────────

export type Competition = 'EuroLeague' | 'NBA' | 'football' | 'other';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type DataQuality = 'high' | 'medium' | 'low';
export type InjuryStatus = 'out' | 'doubtful' | 'questionable';
export type LiveDataProvider = 'api-football' | 'api-basketball';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

export interface Fixture {
  id: string;
  competition: Competition;
  league: string;
  homeTeam: string;
  awayTeam: string;
  /** ISO-8601 date-time string */
  date: string;
  venue?: string;
  status: 'scheduled' | 'live' | 'finished';
  /** Provider team/league numeric IDs when available */
  homeTeamId?: string;
  awayTeamId?: string;
  leagueId?: string;
  /** Preferred live-data provider for this fixture */
  liveDataProvider?: LiveDataProvider;
  /** Provider-specific fixture/game id used for HT/FT polling and result resolution */
  liveDataFixtureId?: string;
}

// ─── Team Form & Stats ────────────────────────────────────────────────────────

export interface TeamFormEntry {
  date: string;
  opponent: string;
  result: 'W' | 'L' | 'D';
  score: string;
  isHome: boolean;
}

export interface TeamRecord {
  wins: number;
  losses: number;
  draws?: number;
}

export interface TeamStats {
  team: string;
  lastFiveGames: TeamFormEntry[];
  homeRecord: TeamRecord;
  awayRecord: TeamRecord;
  averagePointsFor?: number;
  averagePointsAgainst?: number;
  currentStreak?: string;
  standingPosition?: number;
}

// ─── Head-to-Head ─────────────────────────────────────────────────────────────

export interface H2HGame {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  competition: string;
}

export interface H2HRecord {
  totalGames: number;
  homeTeamWins: number;
  awayTeamWins: number;
  draws: number;
  lastFiveGames: H2HGame[];
  averageTotal?: number;
}

// ─── Injuries ─────────────────────────────────────────────────────────────────

export interface InjuredPlayer {
  name: string;
  position?: string;
  status: InjuryStatus;
  reason?: string;
  expectedReturn?: string;
}

export interface InjuryReport {
  team: string;
  players: InjuredPlayer[];
  suspensions: InjuredPlayer[];
  lastUpdated: string;
}

// ─── Schedule Context ─────────────────────────────────────────────────────────

export interface ScheduleContext {
  homeBackToBack: boolean;
  awayBackToBack: boolean;
  homeLastGameDaysAgo?: number;
  awayLastGameDaysAgo?: number;
}

// ─── Aggregated Match Data ────────────────────────────────────────────────────

export interface MatchData {
  fixture: Fixture;
  homeTeamStats: TeamStats;
  awayTeamStats: TeamStats;
  h2h: H2HRecord;
  homeInjuries: InjuryReport;
  awayInjuries: InjuryReport;
  scheduleContext: ScheduleContext;
  dataQuality: DataQuality;
  dataQualityNotes: string[];
  /** Pre-formatted structured provider data injected into the expert prompt */
  structuredContext?: string;
  /** Locally cached historical context from previous events, odds snapshots, and pre/post match notes. */
  cachedKnowledgeContext?: string;
  /** Available betting markets and odds from The Odds API */
  availableOdds?: {
    homeWin?: number;
    draw?: number;          // undefined for basketball (no draws)
    awayWin?: number;
    totalsLine?: number;    // Actual threshold: ~2.5 for soccer, ~215.5 for basketball
    over25?: number;        // "Over" odds at totalsLine
    under25?: number;       // "Under" odds at totalsLine
    bttsYes?: number;       // Both Teams to Score - Yes (football only)
    bttsNo?: number;        // Both Teams to Score - No (football only)
    bookmakerCount: number;
  };
}

// ─── AI Betting Analysis ──────────────────────────────────────────────────────

export interface BettingAnalysis {
  event: string;
  competition: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  keyFacts: string[];
  riskFactors: string[];
  bestBettingMarket: string;
  finalPick: string;
  /** 1–10 */
  confidence: number;
  shortReasoning: string;
  dataQualityNote: string;
  isPickRecommended: boolean;
  noPickReason?: string;
}

// ─── Telegram Output ──────────────────────────────────────────────────────────

export interface FormattedTip {
  competition: Competition;
  text: string;
  confidence: number;
  fixtureId: string;
  fixture: Fixture;
}

export interface DailyReport {
  date: string;
  tips: FormattedTip[];
  generatedAt: string;
  totalFixturesFound: number;
  totalAnalyzed: number;
  totalPublished: number;
}

// ─── Pick Records (for weekly/monthly reports) ────────────────────────────────

export interface PickRecord {
  /** Internal fixture ID, e.g. "api-football_1534911" */
  fixtureId: string;
  /** Match date YYYY-MM-DD */
  date: string;
  competition?: Competition;
  league: string;
  homeTeam: string;
  awayTeam: string;
  /** ISO datetime when the tip was posted to Telegram */
  postedAt: string;
  /** ISO kickoff datetime for rebuilding live-update watchers after restart */
  kickoffAt?: string | null;
  /** Preferred provider used for HT/FT polling and result resolution */
  liveDataProvider?: LiveDataProvider | null;
  /** Provider-specific fixture/game id used by HT/FT polling and result resolution */
  liveDataFixtureId?: string | null;
  /** Short pre-match reasoning shown in the original tip message */
  preMatchReasoning?: string | null;
  /** Telegram message id of the original tip post */
  tipMessageId?: number | null;
  /** Human-readable pick sent to Telegram, e.g. "Άσσος", "Under 2.5" */
  finalPick: string;
  /** Machine token used for outcome resolution, e.g. "h2h/home", "totals/under" */
  bestBettingMarket: string;
  confidence: number;
  /** null = pending (match not yet played), populated after resolution */
  outcome: 'win' | 'loss' | 'void' | null;
  /** Final score string, e.g. "2-1" — populated after resolution */
  actualScore: string | null;
  resolvedAt: string | null;
  /** ISO datetime when the halftime update was sent to Telegram — null if not yet sent */
  halfTimeNotifiedAt: string | null;
  /** ISO datetime when the halftime snapshot was captured to the local intelligence cache */
  halfTimeSnapshotCapturedAt?: string | null;
  /** Telegram message id of the halftime update */
  halfTimeMessageId?: number | null;
  /** ISO datetime when the full-time snapshot was captured to the local intelligence cache */
  fullTimeSnapshotCapturedAt?: string | null;
  /** ISO datetime when the full-time update was sent to Telegram — null if not yet sent */
  fullTimeNotifiedAt: string | null;
  /** Telegram message id of the full-time update */
  fullTimeMessageId?: number | null;
}
