import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { EXPERT_DEVELOPER_PROMPT, buildExpertUserPrompt } from './prompts';
import { buildExpertAnalysisSchema } from './schema';
import { validateAnalysis } from './validator';
import type { Fixture, MatchData, BettingAnalysis } from '../types';

const openai = new OpenAI({ apiKey: config.openai.apiKey, timeout: config.openai.timeoutMs });

/**
 * Live web search for a fixture — retrieves current form, injuries,
 * standings, head-to-head history, and odds from the web.
 * Uses the same web_search_preview-only call pattern as fixture discovery.
 * Returns empty string on failure so analysis can still proceed.
 */
async function fetchLiveContext(fixture: Fixture): Promise<string> {
  const dateStr = fixture.date.substring(0, 10);
  const query =
    `Find the latest information before the match ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
    `in ${fixture.league} on ${dateStr}. Include: ` +
    `(1) current form — last 5 results for both teams with scores, ` +
    `(2) key injuries and suspensions for both sides, ` +
    `(3) head-to-head results from the past 2 years, ` +
    `(4) current league standings / table position, ` +
    `(5) any tactical or motivational context (must-win, rotation expected, cup fatigue), ` +
    `(6) available betting odds for the match.`;

  logger.info(`[expert] fetching live context for ${fixture.homeTeam} vs ${fixture.awayTeam}`);
  try {
    const resp = await openai.responses.create({
      model: config.openai.model,
      input: query,
      tools: [{ type: 'web_search_preview' }],
    } as Parameters<typeof openai.responses.create>[0]);

    const text = (resp as { output_text?: string }).output_text ?? '';
    logger.info(`[expert] live context fetched (${text.length} chars) for ${fixture.homeTeam} vs ${fixture.awayTeam}`);
    return text;
  } catch (err) {
    logger.warn(`[expert] live context fetch failed for ${fixture.id}: ${String(err)}`);
    return '';
  }
}

/**
 * Full expert analysis phase — uses high/xhigh reasoning effort.
 * Returns null if the model declines to make a pick or the response is invalid.
 */
export async function analyzeMatch(matchData: MatchData): Promise<BettingAnalysis | null> {
  const { fixture } = matchData;
  logger.info(
    `[expert] analyzing ${fixture.homeTeam} vs ${fixture.awayTeam} with effort=${config.openai.expertEffort}`
  );

  // Step 1: Live web search — fetch current form, injuries, odds, standings
  const liveContext = await fetchLiveContext(fixture);

  const isSoccer = fixture.competition === 'football';
  const userPrompt = buildExpertUserPrompt(matchData, liveContext);

  let rawJson: unknown;
  try {
    rawJson = await withRetry(
      () =>
        openai.responses.create({
          model: config.openai.model,
          input: [
            // OpenAI newer models prefer 'developer' over 'system' for policy instructions
            { role: 'developer', content: EXPERT_DEVELOPER_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          reasoning: { effort: config.openai.expertEffort },
          text: {
            format: {
              type: 'json_schema',
              name: 'betting_analysis',
              strict: true,
              schema: buildExpertAnalysisSchema(isSoccer),
            },
          },
        } as Parameters<typeof openai.responses.create>[0]),
      { maxAttempts: 3, label: `expert-analysis-${fixture.id}` }
    );
  } catch (err) {
    logger.error(`[expert] OpenAI call failed for ${fixture.id}: ${String(err)}`);
    return null;
  }

  const outputText: string = (rawJson as { output_text?: string }).output_text ?? '';
  if (!outputText) {
    logger.error(`[expert] empty output for ${fixture.id}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    logger.error(`[expert] JSON parse error for ${fixture.id}: ${String(err)}`);
    return null;
  }

  const result = validateAnalysis(parsed, fixture);
  if (!result) {
    logger.warn(`[expert] analysis for ${fixture.id} failed validation`);
    return null;
  }

  if (!result.isPickRecommended) {
    logger.info(`[expert] model declined pick for ${fixture.id}: ${result.noPickReason ?? 'no reason'}`);
    return result;
  }

  if (result.confidence < config.analysis.minConfidenceToPublish) {
    logger.info(
      `[expert] confidence ${result.confidence} below threshold ${config.analysis.minConfidenceToPublish} for ${fixture.id}`
    );
    return { ...result, isPickRecommended: false, noPickReason: `Confidence ${result.confidence}/10 below publish threshold` };
  }

  return result;
}
