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
] as const;

const commentaryClient = createOpenAIClient();
const STAT_LABEL_OVERRIDES: Record<string, string> = { expected_goals: 'xG' };

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