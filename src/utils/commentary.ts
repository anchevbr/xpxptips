import { config } from '../config';
import { logger } from './logger';
import { createOpenAIClient } from './openai-client';
import { extractResponseOutputText, runResponseWithActivityLogging } from './openai-activity';

type UsageMeta = Record<string, string | number | boolean | null | undefined>;

export interface CommentaryStatLine {
  strStat: string;
  intHome: string;
  intAway: string;
}

export interface CommentaryLineupEntry {
  strPlayer: string;
  strHome: string;
  strSubstitute: string;
}

export const DEFAULT_INLINE_COMMENTARY_STATS = [
  'Shots on Goal',
  'Ball Possession',
  'expected_goals',
  'Corner Kicks',
  'Yellow Cards',
  'Rebounds',
  'Assists',
  'Field Goals %',
  'Q1',
  'Q2',
  '1st Half',
  'Q3',
  'Q4',
  '2nd Half',
  'Total',
] as const;

const commentaryClient = createOpenAIClient();
const STAT_LABEL_OVERRIDES: Record<string, string> = {
  expected_goals: 'xG',
  'Shots on Goal': 'Σουτ στην εστία',
  'Ball Possession': 'Κατοχή',
  'Corner Kicks': 'Κόρνερ',
  'Yellow Cards': 'Κίτρινες',
  Rebounds: 'Ριμπάουντ',
  Assists: 'Ασίστ',
  'Field Goals %': 'Ευστοχία εντός πεδιάς',
  'Free Throws %': 'Ευστοχία βολών',
  Q1: '1η περίοδος',
  Q2: '2η περίοδος',
  Q3: '3η περίοδος',
  Q4: '4η περίοδος',
  '1st Half': '1ο ημίχρονο',
  '2nd Half': '2ο ημίχρονο',
  Overtime: 'Παράταση',
  Total: 'Σύνολο',
};

export function sanitizeCommentaryText(raw: string): string {
  let text = raw.trim();

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(
    /\s*\((?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^)\s]*)?\)\s*/gi,
    ' '
  );
  text = text.replace(
    /(^|\s)(?:www\.)?[a-z0-9.-]+\.(?:com|net|org|gr|es|it|de|fr|io|tv|eu|pt|co\.uk)(?:\/[^\s]*)?(?=$|\s|[.,;:!?])/gi,
    '$1'
  );
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\s{2,}/g, ' ');
  text = text.replace(/\s+([.,;:!?])/g, '$1');

  return text.trim();
}

function formatStatLabel(statName: string): string {
  return STAT_LABEL_OVERRIDES[statName] ?? statName;
}

export function formatCommentaryStatsBlock(stats: CommentaryStatLine[]): string {
  if (stats.length === 0) return 'Δεν υπάρχουν διαθέσιμα στατιστικά.';
  return stats
    .map(stat => `  ${formatStatLabel(stat.strStat)}: ${stat.intHome} – ${stat.intAway} (γηπεδούχοι – φιλοξενούμενοι)`)
    .join('\n');
}

export function formatCommentaryLineupBlock(
  lineup: CommentaryLineupEntry[],
  homeTeam: string,
  awayTeam: string,
): string {
  if (lineup.length === 0) return '';

  const starters = lineup.filter(player => player.strSubstitute === 'No');
  const homePlayers = starters
    .filter(player => player.strHome === 'Yes')
    .map(player => player.strPlayer)
    .join(', ');
  const awayPlayers = starters
    .filter(player => player.strHome === 'No')
    .map(player => player.strPlayer)
    .join(', ');

  return `Ενδεκάδα ${homeTeam}: ${homePlayers}\nΕνδεκάδα ${awayTeam}: ${awayPlayers}`;
}

export function buildInlineKeyStats(
  stats: CommentaryStatLine[],
  wantedStats: readonly string[] = DEFAULT_INLINE_COMMENTARY_STATS,
): string {
  const lines: string[] = [];

  for (const statName of wantedStats) {
    const stat = stats.find(candidate => candidate.strStat.toLowerCase() === statName.toLowerCase());
    if (stat) {
      lines.push(`${formatStatLabel(stat.strStat)}: ${stat.intHome}–${stat.intAway}`);
    }
  }

  if (lines.length === 0) {
    for (const stat of stats.slice(0, 4)) {
      lines.push(`${formatStatLabel(stat.strStat)}: ${stat.intHome}–${stat.intAway}`);
    }
  }

  return lines.join(' | ');
}

interface CommentaryPromptOptions {
  scope: string;
  logLabel: string;
  prompt: string;
  usageMeta?: UsageMeta;
  emptyFallbackText: string;
  errorFallbackText: string;
}

export async function runCommentaryPrompt({
  scope,
  logLabel,
  prompt,
  usageMeta = {},
  emptyFallbackText,
  errorFallbackText,
}: CommentaryPromptOptions): Promise<string> {
  const model = config.openai.commentaryModel;

  try {
    const response = await runResponseWithActivityLogging({
      client: commentaryClient,
      scope,
      model,
      timeoutMs: config.openai.timeoutMs,
      usageMeta,
      params: {
        model,
        input: prompt,
        reasoning: { effort: config.openai.commentaryEffort },
        tools: [{ type: 'web_search_preview' }],
      } as Parameters<typeof commentaryClient.responses.stream>[0],
    });

    const text = sanitizeCommentaryText(extractResponseOutputText(response));
    return text || emptyFallbackText;
  } catch (err) {
    logger.warn(`[${logLabel}] GPT call failed: ${String(err)}`);
    return errorFallbackText;
  }
}