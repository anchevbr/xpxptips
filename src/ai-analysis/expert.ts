import { config } from '../config';
import { recordAnalysisSnapshot, recordLiveContextSnapshot } from '../cache/event-intelligence';
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
const RETRYABLE_OPENAI_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const EXTENDED_PROMPT_CACHE_MODELS = new Set(['gpt-5.4']);
const LIVE_CONTEXT_PROMPT_PREFIX = [
  'Βρες το πιο σημαντικό prematch context για το fixture που περιγράφεται παρακάτω.',
  'Προτίμησε επίσημα club και league sites, UEFA/FIFA, έγκυρους local reporters, Reuters/AP, ESPN, BBC, Sky, The Athletic, Kicker, Marca, AS, Mundo Deportivo, Bild, L\'Equipe ή αντίστοιχα αξιόπιστες πηγές.',
  'Επέστρεψε ένα σύντομο scouting note στα ελληνικά μόνο με τα πιο ουσιώδη σημεία:',
  '(1) πρόσφατη φόρμα 3-5 αγώνων,',
  '(2) βασικές απουσίες, τιμωρίες, lineup doubts και πιθανό rotation,',
  '(3) τακτική εικόνα και πιθανό match plan,',
  '(4) εσωτερικό context ομάδας: πίεση προπονητή, δηλώσεις, ψυχολογία, board/fan pressure, πειθαρχικά ή θέματα αποδυτηρίων, μόνο αν αναφέρονται αξιόπιστα,',
  '(5) motivation και match-state context: aggregate, must-win ανάγκη, qualification scenario, κόπωση, ταξίδι, πίεση προγράμματος,',
  '(6) τρέχουσα βαθμολογική θέση αν είναι relevant,',
  '(7) πρόσφατο odds snapshot αν είναι relevant.',
  'Μην κυνηγάς φήμες. Μην επαναλαμβάνεις το ίδιο fact. Εστίασε μόνο σε ό,τι αλλάζει ουσιαστικά tempo, risk, motivation ή market value.',
].join(' ');

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function resolveLiveContextPromptCacheRetention(model: string): 'in_memory' | '24h' {
  if (
    config.openai.liveContextPromptCacheRetention === '24h' &&
    EXTENDED_PROMPT_CACHE_MODELS.has(normalizeModelName(model))
  ) {
    return '24h';
  }

  return 'in_memory';
}

function buildLiveContextQuery(
  fixture: Fixture,
  dateStr: string,
  cachedKnowledgeContext?: string,
): string {
  const cachedBlock = cachedKnowledgeContext?.trim()
    ? `\n\nΤοπική βάση γνώσης / cache:\n${cachedKnowledgeContext}\n\nΟδηγία: ΜΗΝ ξαναψάξεις για παλιές πληροφορίες που καλύπτονται ήδη στο cache. Κάνε web search μόνο για νεότερες ή ελλείπουσες ενημερώσεις γύρω από το συγκεκριμένο fixture.`
    : '';

  return (
    `${LIVE_CONTEXT_PROMPT_PREFIX}\n\n` +
    `Στοιχεία αγώνα:\n` +
    `Γηπεδούχος: ${fixture.homeTeam}\n` +
    `Φιλοξενούμενος: ${fixture.awayTeam}\n` +
    `Λίγκα: ${fixture.league}\n` +
    `Ημερομηνία: ${dateStr}` +
    cachedBlock
  );
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function isRetryableOpenAIError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (typeof status === 'number') {
    return RETRYABLE_OPENAI_STATUS_CODES.has(status);
  }

  const message = error instanceof Error ? error.message : String(error);
  return /rate limit|timed out|timeout|temporarily unavailable|overloaded|connection reset|econnreset|etimedout|socket hang up/i.test(
    message
  );
}

/**
 * Live web search for a fixture — retrieves current form, injuries,
 * standings, head-to-head history, and odds from the web.
 * Uses the same web_search_preview-only call pattern as fixture discovery.
 * Returns empty string on failure so analysis can still proceed.
 */
async function fetchLiveContext(
  fixture: Fixture,
  cachedKnowledgeContext?: string,
): Promise<string> {
  const dateStr = fixture.date.substring(0, 10);
  const model = config.openai.liveContextModel;
  const effort = config.openai.liveContextEffort;
  const startedAt = Date.now();
  const promptCacheRetention = resolveLiveContextPromptCacheRetention(model);
  const query = buildLiveContextQuery(fixture, dateStr, cachedKnowledgeContext);

  logger.info(
    `[expert] fetching live context for ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
    `| model=${model} | effort=${effort} | prompt_cache_retention=${promptCacheRetention} | timeoutMs=${config.openai.timeoutMs}`
  );

  const progressTimer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[expert] live context still running for ${fixture.homeTeam} vs ${fixture.awayTeam} ` +
      `| elapsed=${elapsedSec}s`
    );
  }, 15_000);

  try {
    const resp = await withRetry(
      () =>
        runResponseWithActivityLogging({
          client: openai,
          scope: 'expert-live-context',
          model,
          timeoutMs: config.openai.timeoutMs,
          usageMeta: {
            fixtureId: fixture.id,
            homeTeam: fixture.homeTeam,
            awayTeam: fixture.awayTeam,
            date: dateStr,
          },
          params: {
            model,
            input: query,
            prompt_cache_key: config.openai.liveContextPromptCacheKey,
            prompt_cache_retention: promptCacheRetention,
            reasoning: { effort },
            text: { verbosity: 'low' },
            tools: [{ type: 'web_search_preview' }],
          } as Parameters<typeof openai.responses.stream>[0],
        }),
      {
        maxAttempts: 3,
        initialDelayMs: 2_000,
        label: `expert-live-context-${fixture.id}`,
        shouldRetry: isRetryableOpenAIError,
      }
    );

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
    recordLiveContextSnapshot(fixture, text);
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
  const liveContext = await fetchLiveContext(fixture, matchData.cachedKnowledgeContext);

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
      {
        maxAttempts: 3,
        initialDelayMs: 2_000,
        label: `expert-analysis-${fixture.id}`,
        shouldRetry: isRetryableOpenAIError,
      }
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
    date: fixture.date.slice(0, 10),
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

  const result = validateAnalysis(parsed, matchData);
  if (!result) {
    logger.warn(`[expert] analysis for ${fixture.id} failed validation`);
    return null;
  }

  if (!result.isPickRecommended) {
    recordAnalysisSnapshot(fixture, result);
    logger.info(`[expert] model declined pick for ${fixture.id}: ${result.noPickReason ?? 'no reason'}`);
    return result;
  }

  if (result.confidence < config.analysis.minConfidenceToPublish) {
    recordAnalysisSnapshot(fixture, result);
    logger.info(
      `[expert] confidence ${result.confidence} below threshold ${config.analysis.minConfidenceToPublish} for ${fixture.id}`
    );
    return { ...result, isPickRecommended: false, noPickReason: `Confidence ${result.confidence}/10 below publish threshold` };
  }

  recordAnalysisSnapshot(fixture, result);
  return result;
}
