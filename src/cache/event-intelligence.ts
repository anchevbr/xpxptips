import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import type { BettingAnalysis, Competition, Fixture, MatchData, PickRecord } from '../types';

type StoredOddsSnapshot = NonNullable<MatchData['availableOdds']>;

type StoredStatLine = {
  strStat: string;
  intHome: string;
  intAway: string;
};

type StoredLineupPlayer = {
  strPlayer: string;
  strTeam: string;
  strPosition: string;
  strHome: string;
  strSubstitute: string;
};

type StoredMatchIncident = {
  elapsed: number | null;
  extra: number | null;
  team: string;
  player: string;
  assist: string;
  type: string;
  detail: string;
  comments: string;
};

type StoredLiveSnapshot = {
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  capturedAt: string;
  stats?: StoredStatLine[];
  lineup?: StoredLineupPlayer[];
  incidents?: StoredMatchIncident[];
};

type StoredAnalysisSnapshot = {
  isPickRecommended: boolean;
  noPickReason?: string;
  bestBettingMarket: string;
  finalPick: string;
  confidence: number;
  shortReasoning: string;
  keyFacts: string[];
  riskFactors: string[];
  capturedAt: string;
};

type StoredResolvedSnapshot = {
  outcome: 'win' | 'loss' | 'void';
  actualScore: string;
  resolvedAt: string;
  retrospectiveSummary: string;
};

type EventIntelligenceEntry = {
  fixtureId: string;
  date: string;
  competition: Competition;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt?: string | null;
  updatedAt: string;
  structuredContext?: string;
  liveContextNote?: string;
  availableOdds?: StoredOddsSnapshot;
  analysis?: StoredAnalysisSnapshot;
  halftime?: StoredLiveSnapshot;
  fulltime?: StoredLiveSnapshot;
  resolved?: StoredResolvedSnapshot;
};

const EVENT_INTELLIGENCE_LOG = path.resolve('./data/event-intelligence.json');

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readEntries(): EventIntelligenceEntry[] {
  try {
    if (!fs.existsSync(EVENT_INTELLIGENCE_LOG)) {
      return [];
    }

    return JSON.parse(fs.readFileSync(EVENT_INTELLIGENCE_LOG, 'utf-8')) as EventIntelligenceEntry[];
  } catch (err) {
    logger.warn(`[event-intelligence] could not read cache: ${String(err)}`);
    return [];
  }
}

function writeEntries(entries: EventIntelligenceEntry[]): void {
  try {
    ensureDir(path.dirname(EVENT_INTELLIGENCE_LOG));
    fs.writeFileSync(EVENT_INTELLIGENCE_LOG, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[event-intelligence] could not write cache: ${String(err)}`);
  }
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0370-\u03ff\u1f00-\u1fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameTeamName(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function safeTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function getEntryTimestamp(entry: EventIntelligenceEntry): number {
  const kickoffTimestamp = safeTimestamp(entry.kickoffAt);
  if (Number.isFinite(kickoffTimestamp)) {
    return kickoffTimestamp;
  }

  return safeTimestamp(`${entry.date}T12:00:00Z`);
}

function isEarlierThanFixture(entry: EventIntelligenceEntry, fixture: Fixture): boolean {
  const fixtureTimestamp = safeTimestamp(fixture.date);
  const entryTimestamp = getEntryTimestamp(entry);

  if (Number.isFinite(fixtureTimestamp) && Number.isFinite(entryTimestamp)) {
    return entryTimestamp < fixtureTimestamp;
  }

  return entry.date < fixture.date.slice(0, 10);
}

function compactText(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1).trim()}…`;
}

const SNAPSHOT_FOCUS_STATS = new Set([
  'shots on goal',
  'shots off goal',
  'total shots',
  'ball possession',
  'corner kicks',
  'yellow cards',
  'red cards',
  'goalkeeper saves',
  'rebounds',
  'assists',
  'field goals %',
  'free throws %',
  'q1',
  'q2',
  'q3',
  'q4',
  '1st half',
  '2nd half',
  'overtime',
  'total',
]);

function formatIncidentMinute(incident: StoredMatchIncident): string {
  if (incident.elapsed == null) {
    return '';
  }

  return incident.extra != null
    ? `${incident.elapsed}+${incident.extra}'`
    : `${incident.elapsed}'`;
}

function summarizeSnapshot(snapshot: StoredLiveSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  const parts: string[] = [];

  const statSummary = (snapshot.stats ?? [])
    .filter(stat => SNAPSHOT_FOCUS_STATS.has(stat.strStat.toLowerCase()))
    .slice(0, 4)
    .map(stat => `${stat.strStat} ${stat.intHome}-${stat.intAway}`);

  if (statSummary.length > 0) {
    parts.push(`στατιστικά: ${statSummary.join(', ')}`);
  }

  const incidentSummary = (snapshot.incidents ?? [])
    .filter(incident => {
      const text = `${incident.type} ${incident.detail}`.toLowerCase();
      return /goal|card|penalty|var|subst/.test(text);
    })
    .slice(0, 3)
    .map(incident => {
      const minute = formatIncidentMinute(incident);
      const label = incident.detail || incident.type;
      const subject = incident.player || incident.team;
      return [minute, label, subject].filter(Boolean).join(' ');
    });

  if (incidentSummary.length > 0) {
    parts.push(`events: ${incidentSummary.join('; ')}`);
  }

  return parts.length > 0 ? parts.join(' | ') : undefined;
}

function outcomeLabel(outcome: 'win' | 'loss' | 'void'): string {
  if (outcome === 'win') return 'πληρώθηκε';
  if (outcome === 'loss') return 'χάθηκε';
  return 'επέστρεψε';
}

function formatOddsSnapshot(odds: StoredOddsSnapshot): string {
  const parts: string[] = [];

  if (typeof odds.homeWin === 'number') parts.push(`1 ${odds.homeWin.toFixed(2)}`);
  if (typeof odds.draw === 'number') parts.push(`Χ ${odds.draw.toFixed(2)}`);
  if (typeof odds.awayWin === 'number') parts.push(`2 ${odds.awayWin.toFixed(2)}`);

  if (typeof odds.totalsLine === 'number') {
    if (typeof odds.over25 === 'number') parts.push(`Over ${odds.totalsLine} ${odds.over25.toFixed(2)}`);
    if (typeof odds.under25 === 'number') parts.push(`Under ${odds.totalsLine} ${odds.under25.toFixed(2)}`);
  }

  if (typeof odds.bttsYes === 'number') parts.push(`G/G ${odds.bttsYes.toFixed(2)}`);
  if (typeof odds.bttsNo === 'number') parts.push(`NG ${odds.bttsNo.toFixed(2)}`);

  return parts.join(' | ');
}

function buildRetrospectiveSummary(entry: EventIntelligenceEntry, resolved: StoredResolvedSnapshot): string {
  const prediction = entry.analysis?.isPickRecommended === false
    ? `Δεν είχαμε bet recommendation (${entry.analysis.noPickReason ?? 'χωρίς καθαρό edge'})`
    : entry.analysis
    ? `Είχαμε πάει με ${entry.analysis.finalPick} (${entry.analysis.confidence}/10)`
    : 'Είχαμε αποθηκευμένο μόνο το event context';

  const reasoning = entry.analysis?.shortReasoning
    ? ` Βάση πριν το ματς: ${compactText(entry.analysis.shortReasoning, 180)}`
    : '';

  const liveMatchSummary = summarizeSnapshot(entry.fulltime ?? entry.halftime)
    ? ` Ζωντανή εικόνα αγώνα: ${compactText(summarizeSnapshot(entry.fulltime ?? entry.halftime)!, 180)}`
    : '';

  return `${prediction}. Το ματς έληξε ${resolved.actualScore} και το tip ${outcomeLabel(resolved.outcome)}.${reasoning}${liveMatchSummary}`;
}

function baseEntryFromFixture(fixture: Fixture): EventIntelligenceEntry {
  return {
    fixtureId: fixture.id,
    date: fixture.date.slice(0, 10),
    competition: fixture.competition,
    league: fixture.league,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    kickoffAt: fixture.date,
    updatedAt: new Date().toISOString(),
  };
}

function baseEntryFromPick(pick: PickRecord): EventIntelligenceEntry {
  return {
    fixtureId: pick.fixtureId,
    date: pick.date,
    competition: pick.competition ?? 'other',
    league: pick.league,
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
    kickoffAt: pick.kickoffAt ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function upsertEntry(
  fixtureId: string,
  factory: () => EventIntelligenceEntry,
  mutate: (entry: EventIntelligenceEntry) => void,
): void {
  const entries = readEntries();
  const index = entries.findIndex(entry => entry.fixtureId === fixtureId);
  const entry = index >= 0 ? entries[index]! : factory();

  mutate(entry);
  entry.updatedAt = new Date().toISOString();

  if (index >= 0) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }

  writeEntries(entries);
}

export function recordEnrichmentSnapshot(
  fixture: Fixture,
  structuredContext: string | undefined,
  availableOdds: MatchData['availableOdds'] | undefined,
): void {
  if (!structuredContext && !availableOdds) {
    return;
  }

  upsertEntry(fixture.id, () => baseEntryFromFixture(fixture), entry => {
    if (structuredContext) {
      entry.structuredContext = structuredContext;
    }
    if (availableOdds) {
      entry.availableOdds = availableOdds;
    }
  });
}

export function recordLiveContextSnapshot(fixture: Fixture, note: string): void {
  if (!note.trim()) {
    return;
  }

  upsertEntry(fixture.id, () => baseEntryFromFixture(fixture), entry => {
    entry.liveContextNote = note.trim();
  });
}

export function recordAnalysisSnapshot(fixture: Fixture, analysis: BettingAnalysis): void {
  upsertEntry(fixture.id, () => baseEntryFromFixture(fixture), entry => {
    entry.analysis = {
      isPickRecommended: analysis.isPickRecommended,
      noPickReason: analysis.noPickReason,
      bestBettingMarket: analysis.bestBettingMarket,
      finalPick: analysis.finalPick,
      confidence: analysis.confidence,
      shortReasoning: analysis.shortReasoning,
      keyFacts: analysis.keyFacts,
      riskFactors: analysis.riskFactors,
      capturedAt: new Date().toISOString(),
    };
  });
}

function recordLiveSnapshot(
  phase: 'halftime' | 'fulltime',
  pick: PickRecord,
  snapshot: {
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    stats: Array<{ strStat: string; intHome: string; intAway: string }>;
    lineup: Array<{
      strPlayer: string;
      strTeam: string;
      strPosition: string;
      strHome: string;
      strSubstitute: string;
    }>;
    incidents: Array<{
      elapsed: number | null;
      extra: number | null;
      team: string;
      player: string;
      assist: string;
      type: string;
      detail: string;
      comments: string;
    }>;
  },
): void {
  upsertEntry(pick.fixtureId, () => baseEntryFromPick(pick), entry => {
    entry[phase] = {
      status: snapshot.status,
      homeScore: snapshot.homeScore,
      awayScore: snapshot.awayScore,
      capturedAt: new Date().toISOString(),
      stats: snapshot.stats.length > 0 ? snapshot.stats.map(stat => ({ ...stat })) : undefined,
      lineup: snapshot.lineup.length > 0 ? snapshot.lineup.map(player => ({ ...player })) : undefined,
      incidents: snapshot.incidents.length > 0 ? snapshot.incidents.map(incident => ({ ...incident })) : undefined,
    };
  });
}

export function recordHalftimeSnapshot(
  pick: PickRecord,
  snapshot: {
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    stats: Array<{ strStat: string; intHome: string; intAway: string }>;
    lineup: Array<{
      strPlayer: string;
      strTeam: string;
      strPosition: string;
      strHome: string;
      strSubstitute: string;
    }>;
    incidents: Array<{
      elapsed: number | null;
      extra: number | null;
      team: string;
      player: string;
      assist: string;
      type: string;
      detail: string;
      comments: string;
    }>;
  },
): void {
  recordLiveSnapshot('halftime', pick, snapshot);
}

export function recordFulltimeSnapshot(
  pick: PickRecord,
  snapshot: {
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    stats: Array<{ strStat: string; intHome: string; intAway: string }>;
    lineup: Array<{
      strPlayer: string;
      strTeam: string;
      strPosition: string;
      strHome: string;
      strSubstitute: string;
    }>;
    incidents: Array<{
      elapsed: number | null;
      extra: number | null;
      team: string;
      player: string;
      assist: string;
      type: string;
      detail: string;
      comments: string;
    }>;
  },
): void {
  recordLiveSnapshot('fulltime', pick, snapshot);
}

export function recordResolvedSnapshot(pick: PickRecord): void {
  if (!pick.actualScore || !pick.resolvedAt || !pick.outcome) {
    return;
  }

  upsertEntry(
    pick.fixtureId,
    () => ({
      fixtureId: pick.fixtureId,
      date: pick.date,
      competition: pick.competition ?? 'other',
      league: pick.league,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
      kickoffAt: pick.kickoffAt ?? null,
      updatedAt: new Date().toISOString(),
    }),
    entry => {
      const resolved: StoredResolvedSnapshot = {
        outcome: pick.outcome!,
        actualScore: pick.actualScore!,
        resolvedAt: pick.resolvedAt!,
        retrospectiveSummary: '',
      };

      resolved.retrospectiveSummary = buildRetrospectiveSummary(entry, resolved);
      entry.resolved = resolved;
    },
  );
}

function formatHistoryEntry(entry: EventIntelligenceEntry, focusTeam?: string): string {
  const opponent = focusTeam
    ? sameTeamName(entry.homeTeam, focusTeam)
      ? entry.awayTeam
      : entry.homeTeam
    : `${entry.homeTeam} vs ${entry.awayTeam}`;

  const meta: string[] = [];
  if (focusTeam) {
    meta.push(`vs ${opponent}`);
  } else {
    meta.push(`${entry.homeTeam} vs ${entry.awayTeam}`);
  }

  if (entry.analysis?.isPickRecommended === true) {
    meta.push(`πρόβλεψη ${entry.analysis.finalPick} (${entry.analysis.confidence}/10)`);
  } else if (entry.analysis?.isPickRecommended === false && entry.analysis.noPickReason) {
    meta.push(`no-pick: ${compactText(entry.analysis.noPickReason, 90)}`);
  }

  if (entry.availableOdds) {
    const odds = formatOddsSnapshot(entry.availableOdds);
    if (odds) {
      meta.push(`odds ${odds}`);
    }
  }

  if (entry.resolved) {
    meta.push(`τελικό ${entry.resolved.actualScore} (${outcomeLabel(entry.resolved.outcome)})`);
  }

  const details = entry.resolved?.retrospectiveSummary
    ?? summarizeSnapshot(entry.fulltime)
    ?? summarizeSnapshot(entry.halftime)
    ?? entry.analysis?.shortReasoning
    ?? entry.liveContextNote
    ?? entry.structuredContext
    ?? '';

  const lines = [`- ${entry.date} | ${meta.join(' | ')}`];
  if (details) {
    lines.push(`  ${compactText(details)}`);
  }

  return lines.join('\n');
}

export function buildCachedKnowledgeContext(fixture: Fixture): string | undefined {
  const entries = readEntries().filter(
    entry => entry.fixtureId !== fixture.id && isEarlierThanFixture(entry, fixture),
  );

  if (entries.length === 0) {
    return undefined;
  }

  const sorted = [...entries].sort((left, right) => getEntryTimestamp(right) - getEntryTimestamp(left));
  const usedFixtureIds = new Set<string>();

  const homeHistory = sorted.filter(entry => sameTeamName(entry.homeTeam, fixture.homeTeam) || sameTeamName(entry.awayTeam, fixture.homeTeam)).slice(0, 2);
  homeHistory.forEach(entry => usedFixtureIds.add(entry.fixtureId));

  const awayHistory = sorted.filter(entry => !usedFixtureIds.has(entry.fixtureId) && (sameTeamName(entry.homeTeam, fixture.awayTeam) || sameTeamName(entry.awayTeam, fixture.awayTeam))).slice(0, 2);
  awayHistory.forEach(entry => usedFixtureIds.add(entry.fixtureId));

  const leagueHistory = sorted.filter(entry => !usedFixtureIds.has(entry.fixtureId) && entry.league === fixture.league).slice(0, 2);

  const lines: string[] = [
    '═══ ΤΟΠΙΚΗ ΒΑΣΗ ΓΝΩΣΗΣ / CACHE ─────────────────────────────',
    'Χρησιμοποίησε αυτό το ιστορικό σαν τοπικό dossier και ψάξε online μόνο για νεότερα ή ελλείποντα στοιχεία.',
  ];

  if (homeHistory.length > 0) {
    lines.push(`Πρόσφατο dossier για ${fixture.homeTeam}:`);
    homeHistory.forEach(entry => lines.push(formatHistoryEntry(entry, fixture.homeTeam)));
  }

  if (awayHistory.length > 0) {
    lines.push(`Πρόσφατο dossier για ${fixture.awayTeam}:`);
    awayHistory.forEach(entry => lines.push(formatHistoryEntry(entry, fixture.awayTeam)));
  }

  if (leagueHistory.length > 0) {
    lines.push(`Σχετικά πρόσφατα events στη ${fixture.league}:`);
    leagueHistory.forEach(entry => lines.push(formatHistoryEntry(entry)));
  }

  return lines.length > 2 ? lines.join('\n') : undefined;
}