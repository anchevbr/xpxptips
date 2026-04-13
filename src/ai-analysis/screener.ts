import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { SCREENING_DEVELOPER_PROMPT, buildScreeningUserPrompt } from './prompts';
import { screeningSchema } from './schema';
import type { Fixture, ScreeningResult, DataQuality } from '../types';

const openai = new OpenAI({ apiKey: config.openai.apiKey, timeout: config.openai.timeoutMs });

interface RawAssessment {
  fixtureId: string;
  interestScore: number;
  dataQuality: string;
  reasons: string[];
  shouldAnalyze: boolean;
}

/**
 * Fast screening phase — uses medium reasoning effort.
 * Scores all today's fixtures and returns those worth deep analysis.
 */
export async function screenFixtures(
  fixtures: Fixture[],
  date: string
): Promise<ScreeningResult[]> {
  if (fixtures.length === 0) {
    logger.info('[screener] no fixtures to screen');
    return [];
  }

  logger.info(`[screener] screening ${fixtures.length} fixtures with effort=${config.openai.screeningEffort}`);

  const userPrompt = buildScreeningUserPrompt(fixtures, date);

  const rawJson = await withRetry(
    () =>
      openai.responses.create({
        model: config.openai.model,
        input: [
          // OpenAI newer models prefer 'developer' over 'system' for policy instructions
          { role: 'developer', content: SCREENING_DEVELOPER_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        reasoning: { effort: config.openai.screeningEffort },
        text: {
          format: {
            type: 'json_schema',
            name: 'screening_result',
            strict: true,
            schema: screeningSchema,
          },
        },
      } as Parameters<typeof openai.responses.create>[0]),
    { maxAttempts: 3, label: 'screening' }
  );

  const outputText: string = (rawJson as { output_text?: string }).output_text ?? '';
  if (!outputText) {
    logger.error('[screener] empty output from model');
    return [];
  }

  let parsed: { assessments: RawAssessment[] };
  try {
    parsed = JSON.parse(outputText) as { assessments: RawAssessment[] };
  } catch (err) {
    logger.error(`[screener] JSON parse error: ${String(err)}\nRaw: ${outputText.slice(0, 200)}`);
    return [];
  }

  const fixtureMap = new Map(fixtures.map((f) => [f.id, f]));

  return parsed.assessments
    .filter((a) => fixtureMap.has(a.fixtureId))
    .map((a): ScreeningResult => ({
      fixtureId: a.fixtureId,
      fixture: fixtureMap.get(a.fixtureId)!,
      interestScore: clamp(a.interestScore, 0, 10),
      dataQuality: (['high', 'medium', 'low'].includes(a.dataQuality)
        ? a.dataQuality
        : 'low') as DataQuality,
      reasons: Array.isArray(a.reasons) ? a.reasons : [],
      shouldAnalyze: Boolean(a.shouldAnalyze),
    }))
    .sort((a, b) => b.interestScore - a.interestScore);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
