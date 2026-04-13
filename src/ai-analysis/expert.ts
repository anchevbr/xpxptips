import { config } from '../config';
import { logger } from '../utils/logger';
import { createOpenAIClient } from '../utils/openai-client';
import { extractResponseOutputText, runResponseWithActivityLogging } from '../utils/openai-activity';
import { getOpenAIUsage, logOpenAIUsage } from '../utils/openai-usage';
import { withRetry } from '../utils/retry';
import { EXPERT_DEVELOPER_PROMPT, buildExpertUserPrompt } from './prompts';
import { buildExpertAnalysisSchema } from './schema';
import { validateAnalysis } from './validator';
import type { Fixture, MatchData, BettingAnalysis } from '../types';

const openai = createOpenAIClient();

/**
 * Live web search for a fixture — retrieves current form, injuries,
 * standings, head-to-head history, and odds from the web.
 * Uses the same web_search_preview-only call pattern as fixture discovery.
 * Returns empty string on failure so analysis can still proceed.
 */
async function fetchLiveContext(fixture: Fixture): Promise<string> {
  const dateStr = fixture.date.substring(0, 10);
  const model = config.openai.model;
  const effort = config.openai.expertEffort;
  const startedAt = Date.now();
  const query =
    `Find only the most important pre-match information for ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
    `in ${fixture.league} on ${dateStr}. ` +
    `Prefer official club, league, UEFA/FIFA, or major sports-media sources. ` +
    `Return a compact scouting note with only these sections: ` +
    `(1) form from the last 3-5 matches, ` +
    `(2) key injuries/suspensions, ` +
    `(3) notable head-to-head results from the last 2 years only if relevant, ` +
    `(4) current table position, ` +
    `(5) one short tactical/motivation note, ` +
    `(6) current odds snapshot if available. ` +
    `Be concise and avoid duplicate findings.`;

  logger.info(
    `[expert] fetching live context for ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
    `| model=${model} | effort=${effort} | timeoutMs=${config.openai.timeoutMs}`
  );

  const progressTimer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[expert] live context still running for ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
      `| elapsed=${elapsedSec}s`
    );
  }, 15_000);

  try {
    const resp = await runResponseWithActivityLogging({
      client: openai,
      scope: 'expert-live-context',
      model,
      timeoutMs: config.openai.timeoutMs,
      usageMeta: {
        fixtureId: fixture.id,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
      },
      params: {
        model,
        input: query,
        reasoning: { effort },
        text: { verbosity: 'low' },
        tools: [{ type: 'web_search_preview' }],
      } as Parameters<typeof openai.responses.stream>[0],
    });

    clearInterval(progressTimer);

    const text = extractResponseOutputText(resp);
    if (!text) {
      const usage = getOpenAIUsage(resp as { usage?: unknown });
      const outputTokens = usage?.output_tokens;
      const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens;
      const visibleOutputTokens =
        typeof outputTokens === 'number' && typeof reasoningTokens === 'number'
          ? outputTokens - reasoningTokens
          : undefined;

      const parts = [
        `[expert] live context returned no visible text for ${fixture.homeTeam} vs ${fixture.awayTeam}`,
        `elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
      ];

      if (typeof outputTokens === 'number') parts.push(`output_tokens=${outputTokens}`);
      if (typeof reasoningTokens === 'number') parts.push(`reasoning_output_tokens=${reasoningTokens}`);
      if (typeof visibleOutputTokens === 'number') parts.push(`visible_output_tokens=${visibleOutputTokens}`);

      logger.warn(parts.join(' | '));
      return '';
    }

    logger.info(
      `[expert] live context fetched (${text.length} chars) for ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
      `| elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`
    );
    return text;
  } catch (err) {
    clearInterval(progressTimer);
    logger.warn(`[expert] live context fetch failed for ${fixture.id}: ${String(err)}`);
    return '';
  }
}

/**
 * Full expert analysis phase — uses the configured reasoning effort.
 * Returns null if the model declines to make a pick or the response is invalid.
 */
export async function analyzeMatch(matchData: MatchData): Promise<BettingAnalysis | null> {
  const { fixture } = matchData;
  const model = config.openai.model;
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
          model,
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

  logOpenAIUsage('expert-analysis', model, rawJson as { id?: string; usage?: unknown }, {
    fixtureId: fixture.id,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    competition: fixture.competition,
  });

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
