/**
 * Classification Challenge Service - Memory Completeness Analysis
 *
 * Uses an LLM to analyze whether a memory is complete and well-formed.
 * When enabled via feature toggle, this service suggests missing fields
 * that would strengthen the memory (invalidates_if, derived_from, etc.)
 *
 * Key insight: Memory type is determined by field presence (source vs derived_from),
 * not by a type column. The service now focuses on completeness rather than
 * type misclassification.
 *
 * When the LLM detects incomplete memories with sufficient confidence,
 * it returns suggestions that can be included in the response.
 */

import type { Env } from '../types/index.js';
import type { Config } from '../lib/config.js';
import { createLazyLogger } from '../lib/lazy-logger.js';
import { withRetry } from '../lib/retry.js';
import { callExternalLLM } from '../lib/embeddings.js';

const getLog = createLazyLogger('ClassificationChallenge', 'classification-init');

/** Display type for memories (determined by field presence) */
type DisplayType = 'memory';

/** Fields that might be missing from a memory */
export type MissingFieldType = 'invalidates_if' | 'confirms_if' | 'derived_from' | 'source' | 'resolves_by';

/** A missing field suggestion */
export interface MissingField {
  field: MissingFieldType;
  reason: string;
}

/** Result of memory completeness analysis */
export interface MemoryCompleteness {
  is_complete: boolean;
  missing_fields: MissingField[];
  confidence: number;
  reasoning: string;
}

/** @deprecated Use MemoryCompleteness - kept for backwards compatibility */
export interface ClassificationChallenge {
  correctly_classified: boolean;
  suggested_type: DisplayType;
  confidence: number;
  reasoning: string;
  suggested_fields?: {
    source?: string;
  };
  /** New field for completeness suggestions */
  missing_fields?: MissingField[];
}

/** JSON schema for classification response (legacy) */
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    correctly_classified: { type: 'boolean' },
    suggested_type: { type: 'string', enum: ['obs', 'thought'] },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
  required: ['correctly_classified', 'suggested_type', 'confidence', 'reasoning'],
};

/** JSON schema for completeness analysis response */
const COMPLETENESS_SCHEMA = {
  type: 'object',
  properties: {
    is_complete: { type: 'boolean' },
    missing_fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['invalidates_if', 'confirms_if', 'derived_from', 'source', 'resolves_by'] },
          reason: { type: 'string' },
        },
        required: ['field', 'reason'],
      },
    },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
  required: ['is_complete', 'missing_fields', 'confidence', 'reasoning'],
};

/**
 * Build the prompt for classification analysis.
 */
function buildClassificationPrompt(content: string, currentType: DisplayType): string {
  return `Analyze whether this content is correctly classified as a "${currentType}".

Content: "${content}"

Classification definitions:
- OBSERVATION: Direct facts from reality. Things that were seen, measured, read, or received from external sources. Observations are concrete, specific, and can be verified by pointing to a source (market data, news article, email, tool output, human statement). They should not contain inference or interpretation.

- THOUGHT: Beliefs derived from observations. These include interpretations, conclusions, or inferences. Thoughts are what you THINK based on what you KNOW. They may be wrong and should have falsification conditions.

- PREDICTION: Time-bound thoughts with a deadline and outcome condition. A specific prediction that will be resolved by a certain date.

Key distinguishing questions:
1. Is this a direct report of something observed/received, or an interpretation/conclusion?
2. Could this be directly attributed to a source (market, news, tool, human)?
3. Does this contain words like "suggests", "implies", "means", "will", "should" that indicate inference?
4. Is there a specific deadline or time-bound claim?

Is this correctly classified as a "${currentType}"?

Respond with JSON only:
{
  "correctly_classified": boolean,
  "suggested_type": "observation" or "thought" or "prediction",
  "confidence": number between 0 and 1,
  "reasoning": "brief explanation of your assessment"
}`;
}

/**
 * Parse the LLM response for classification analysis.
 */
function parseClassificationResponse(responseText: string): {
  correctly_classified: boolean;
  suggested_type: DisplayType;
  confidence: number;
  reasoning: string;
} | null {
  try {
    const parsed = JSON.parse(responseText);
    if (typeof parsed.correctly_classified === 'boolean' && typeof parsed.confidence === 'number') {
      return {
        correctly_classified: parsed.correctly_classified,
        suggested_type: 'memory',
        confidence: Number(parsed.confidence),
        reasoning: String(parsed.reasoning || ''),
      };
    }
  } catch {
    // Not valid JSON, try regex extraction
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        correctly_classified: Boolean(parsed.correctly_classified),
        suggested_type: 'memory',
        confidence: Number(parsed.confidence) || 0,
        reasoning: String(parsed.reasoning || ''),
      };
    } catch {
      // JSON extraction failed
    }
  }

  getLog().warn('classification_parse_failed', { response_preview: responseText.slice(0, 200) });
  return null;
}

/**
 * Extract response content from various model output formats.
 */
function extractContent(response: unknown): string {
  const r = response as {
    output?: Array<{
      type: string;
      content?: Array<{ text?: string }>;
    }>;
    response?: string;
  };

  // GPT-OSS Responses API format
  if (r?.output && Array.isArray(r.output)) {
    const msg = r.output.find((o) => o.type === 'message');
    if (msg?.content?.[0]?.text) return msg.content[0].text;
  }

  // Standard chat completion format
  if (r?.response) return r.response;

  // Raw string
  if (typeof response === 'string') return response;

  return JSON.stringify(response);
}

/**
 * Challenge the classification of a memory.
 *
 * @returns Challenge object if misclassification detected above threshold, null otherwise
 */
export async function challengeClassification(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    content: string;
    current_type: DisplayType;
    requestId?: string;
  }
): Promise<ClassificationChallenge | null> {
  // Check if feature is enabled
  if (!config.classification.challengeEnabled) {
    return null;
  }

  const prompt = buildClassificationPrompt(params.content, params.current_type);

  try {
    let responseText: string;

    if (env.LLM_JUDGE_URL) {
      // Route through external LLM
      responseText = await withRetry(
        () => callExternalLLM(
          env.LLM_JUDGE_URL!,
          prompt,
          { apiKey: env.LLM_JUDGE_API_KEY, model: env.LLM_JUDGE_MODEL, requestId: params.requestId }
        ),
        { retries: 2, delay: 100 }
      );
    } else {
      // Fall back to Workers AI
      const response = await withRetry(
        async () => {
          const model = config.classification.challengeModel;
          const isGptOss = model.includes('gpt-oss');

          // AI Gateway config for observability (optional)
          const gatewayConfig = config.aiGatewayId
            ? {
                gateway: {
                  id: config.aiGatewayId,
                  metadata: {
                    service: 'pantainos-memory',
                    operation: 'classification_challenge',
                    model,
                  },
                },
              }
            : undefined;

          if (isGptOss) {
            return await ai.run(
              model as Parameters<typeof ai.run>[0],
              {
                input: prompt,
                instructions: 'Return only valid JSON matching the schema',
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'classification_check',
                    strict: true,
                    schema: CLASSIFICATION_SCHEMA,
                  },
                },
              } as Parameters<typeof ai.run>[1],
              gatewayConfig
            );
          } else {
            return await ai.run(
              model as Parameters<typeof ai.run>[0],
              {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
              } as Parameters<typeof ai.run>[1],
              gatewayConfig
            );
          }
        },
        { retries: 2, delay: 100 }
      );

      responseText = extractContent(response);
    }

    const result = parseClassificationResponse(responseText);

    if (!result) {
      return null;
    }

    if (
      !result.correctly_classified &&
      result.confidence >= config.classification.challengeThreshold &&
      result.suggested_type !== params.current_type
    ) {
      getLog().info('classification_challenge_triggered', {
        current_type: params.current_type,
        suggested_type: result.suggested_type,
        confidence: result.confidence,
        content_preview: params.content.slice(0, 100),
      });

      const challenge: ClassificationChallenge = {
        correctly_classified: false,
        suggested_type: result.suggested_type,
        confidence: result.confidence,
        reasoning: result.reasoning,
      };

      // Add suggested fields based on suggested type
      if (result.suggested_type === 'observation') {
        // Suggest a likely source based on content analysis
        challenge.suggested_fields = {
          source: inferLikelySource(params.content),
        };
      }
      // For thought/prediction, we can't automatically determine derived_from
      // User will need to specify these manually

      return challenge;
    }

    return null;
  } catch (error) {
    getLog().error('classification_challenge_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Infer the most likely observation source based on content.
 * This is a heuristic - the user should verify.
 */
function inferLikelySource(content: string): string {
  const lowerContent = content.toLowerCase();

  // Market data indicators
  if (
    lowerContent.includes('price') ||
    lowerContent.includes('stock') ||
    lowerContent.includes('market') ||
    lowerContent.includes('trading') ||
    lowerContent.includes('$') ||
    lowerContent.match(/\b(aapl|msft|googl|amzn|nvda)\b/i)
  ) {
    return 'market';
  }

  // News indicators
  if (
    lowerContent.includes('reported') ||
    lowerContent.includes('announced') ||
    lowerContent.includes('according to') ||
    lowerContent.includes('news')
  ) {
    return 'news';
  }

  // Earnings indicators
  if (
    lowerContent.includes('earnings') ||
    lowerContent.includes('revenue') ||
    lowerContent.includes('quarter') ||
    lowerContent.includes('guidance')
  ) {
    return 'earnings';
  }

  // Email indicators
  if (
    lowerContent.includes('email') ||
    lowerContent.includes('sent') ||
    lowerContent.includes('received')
  ) {
    return 'email';
  }

  // Tool indicators
  if (
    lowerContent.includes('api') ||
    lowerContent.includes('response') ||
    lowerContent.includes('output') ||
    lowerContent.includes('result')
  ) {
    return 'tool';
  }

  // Default to human if no clear indicator
  return 'human';
}

/**
 * Format a classification challenge for human-readable MCP output.
 * Since all memories use the same underlying structure, misclassified memories
 * should be retracted and recreated with the correct tool.
 * @deprecated Use formatCompletenessOutput instead
 */
export function formatChallengeOutput(challenge: ClassificationChallenge, currentType: DisplayType): string {
  // If we have missing fields, use the new format
  if (challenge.missing_fields && challenge.missing_fields.length > 0) {
    return formatCompletenessOutput({
      is_complete: false,
      missing_fields: challenge.missing_fields,
      confidence: challenge.confidence,
      reasoning: challenge.reasoning,
    });
  }

  // Legacy format for type misclassification (deprecated — types are unified now)
  let output = `\n⚠️ Classification Challenge:\n`;
  output += `This memory may need additional fields.\n`;
  output += `Confidence: ${Math.round(challenge.confidence * 100)}%\n`;
  output += `Reasoning: "${challenge.reasoning}"\n`;

  if (challenge.suggested_fields?.source) {
    output += `\nSuggested source: ${challenge.suggested_fields.source}\n`;
  }

  output += `\nTo fix: Update this memory with the appropriate fields (source, derived_from, etc).`;

  return output;
}

// ============================================
// Memory Completeness Analysis (New Approach)
// ============================================

/**
 * Build the prompt for completeness analysis.
 */
function buildCompletenessPrompt(
  content: string,
  currentFields: {
    has_source?: boolean;
    has_derived_from?: boolean;
    has_invalidates_if?: boolean;
    has_confirms_if?: boolean;
    has_resolves_by?: boolean;
  }
): string {
  const hasSource = currentFields.has_source === true;

  return `Analyze whether this memory is complete and well-formed.

Content: "${content}"

Current fields present: ${JSON.stringify(currentFields)}
Origin: ${hasSource ? 'Sourced perception (recorded from external input)' : 'Derived perception (inferred from other memories)'}

Field definitions:
- source: Where the information came from (market, news, tool, human, etc.)
- derived_from: IDs of memories this perception is based on
- invalidates_if: Conditions that would prove this memory wrong (makes claims falsifiable)
- confirms_if: Conditions that would strengthen confidence in this memory
- resolves_by: Deadline for time-bound predictions (Unix timestamp)
${hasSource ? `
IMPORTANT — Sourced perception leniency rules:
Sourced perceptions record WHAT WAS SAID or WHAT HAPPENED. They are not the author's own claims.
- If someone said "X will happen in 3 years," that is a QUOTE, not a prediction by the memory author. Do NOT require resolves_by.
- Falsifiable claims WITHIN quotes belong to the speaker, not the memory. Do NOT require invalidates_if for quoted/attributed claims.
- invalidates_if and confirms_if are NICE TO HAVE on sourced perceptions, never required. Only flag them if truly obvious and simple (1 condition max).
- confirms_if is NEVER required for sourced perceptions.
- A sourced perception with source + content is COMPLETE. Err heavily toward marking sourced perceptions as complete.
` : ''}
Check for these completeness issues:
1. ${hasSource ? 'SKIP for sourced perceptions unless the memory itself (not quoted speakers) makes a novel prediction' : 'Falsifiable claims without invalidates_if conditions - any claim that could be proven wrong should ideally have kill conditions'}
2. Apparent inferences without derived_from - if this seems like a conclusion based on other information, it should trace its reasoning
3. ${hasSource ? 'SKIP for sourced perceptions — quoted time-bound claims belong to the speaker' : 'Time-bound predictions without resolves_by/outcome_condition - predictions with implicit deadlines should make them explicit'}
4. Claims that reference external information without source attribution

Note: Not every memory needs every field. Simple perceptions may be complete as-is.
${hasSource ? 'Sourced perceptions are almost always complete if they have a source. Be very reluctant to flag missing fields.' : 'Focus on genuinely missing fields that would strengthen the memory, not theoretical completeness.'}

Respond with JSON only:
{
  "is_complete": boolean,
  "missing_fields": [
    {"field": "invalidates_if" | "confirms_if" | "derived_from" | "source" | "resolves_by", "reason": "brief explanation"}
  ],
  "confidence": number between 0 and 1,
  "reasoning": "brief overall assessment"
}`;
}

/**
 * Parse the LLM response for completeness analysis.
 */
function parseCompletenessResponse(responseText: string): MemoryCompleteness | null {
  try {
    // Try direct JSON parse
    const parsed = JSON.parse(responseText);
    if (typeof parsed.is_complete === 'boolean' && Array.isArray(parsed.missing_fields)) {
      return {
        is_complete: parsed.is_complete,
        missing_fields: parsed.missing_fields.map((f: { field: string; reason: string }) => ({
          field: f.field as MissingFieldType,
          reason: String(f.reason || ''),
        })),
        confidence: Number(parsed.confidence) || 0,
        reasoning: String(parsed.reasoning || ''),
      };
    }
  } catch {
    // Not valid JSON, try regex extraction
  }

  // Fallback: Extract JSON from response text
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.is_complete === 'boolean') {
        return {
          is_complete: parsed.is_complete,
          missing_fields: (parsed.missing_fields || []).map((f: { field: string; reason: string }) => ({
            field: f.field as MissingFieldType,
            reason: String(f.reason || ''),
          })),
          confidence: Number(parsed.confidence) || 0,
          reasoning: String(parsed.reasoning || ''),
        };
      }
    } catch {
      // JSON extraction failed
    }
  }

  getLog().warn('completeness_parse_failed', { response_preview: responseText.slice(0, 200) });
  return null;
}

/**
 * Check if a memory is complete and suggest missing fields.
 *
 * @returns MemoryCompleteness object with suggestions, or null if complete/disabled
 */
export async function checkMemoryCompleteness(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    content: string;
    has_source?: boolean;
    has_derived_from?: boolean;
    has_invalidates_if?: boolean;
    has_confirms_if?: boolean;
    has_resolves_by?: boolean;
    requestId?: string;
  }
): Promise<MemoryCompleteness | null> {
  // Check if feature is enabled (reuse the same toggle)
  if (!config.classification.challengeEnabled) {
    return null;
  }

  const prompt = buildCompletenessPrompt(params.content, {
    has_source: params.has_source,
    has_derived_from: params.has_derived_from,
    has_invalidates_if: params.has_invalidates_if,
    has_confirms_if: params.has_confirms_if,
    has_resolves_by: params.has_resolves_by,
  });

  try {
    let responseText: string;

    if (env.LLM_JUDGE_URL) {
      // Route through external LLM
      responseText = await withRetry(
        () => callExternalLLM(
          env.LLM_JUDGE_URL!,
          prompt,
          { apiKey: env.LLM_JUDGE_API_KEY, model: env.LLM_JUDGE_MODEL, requestId: params.requestId }
        ),
        { retries: 2, delay: 100 }
      );
    } else {
      // Fall back to Workers AI
      const response = await withRetry(
        async () => {
          const model = config.classification.challengeModel;
          const isGptOss = model.includes('gpt-oss');

          const gatewayConfig = config.aiGatewayId
            ? {
                gateway: {
                  id: config.aiGatewayId,
                  metadata: {
                    service: 'pantainos-memory',
                    operation: 'completeness_check',
                    model,
                  },
                },
              }
            : undefined;

          if (isGptOss) {
            return await ai.run(
              model as Parameters<typeof ai.run>[0],
              {
                input: prompt,
                instructions: 'Return only valid JSON matching the schema',
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'completeness_check',
                    strict: true,
                    schema: COMPLETENESS_SCHEMA,
                  },
                },
              } as Parameters<typeof ai.run>[1],
              gatewayConfig
            );
          } else {
            return await ai.run(
              model as Parameters<typeof ai.run>[0],
              {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 400,
              } as Parameters<typeof ai.run>[1],
              gatewayConfig
            );
          }
        },
        { retries: 2, delay: 100 }
      );

      responseText = extractContent(response);
    }

    const result = parseCompletenessResponse(responseText);

    if (!result) {
      return null;
    }

    // Only return if:
    // 1. Memory is incomplete according to LLM
    // 2. Confidence is above threshold
    // 3. There are actual missing fields
    if (
      !result.is_complete &&
      result.confidence >= config.classification.challengeThreshold &&
      result.missing_fields.length > 0
    ) {
      getLog().info('memory_completeness_check', {
        is_complete: result.is_complete,
        missing_fields: result.missing_fields.map((f) => f.field),
        confidence: result.confidence,
        content_preview: params.content.slice(0, 100),
      });

      return result;
    }

    return null;
  } catch (error) {
    getLog().error('completeness_check_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Format memory completeness result for human-readable MCP output.
 */
export function formatCompletenessOutput(completeness: MemoryCompleteness): string {
  if (completeness.is_complete || completeness.missing_fields.length === 0) {
    return ''; // No output needed for complete memories
  }

  let output = `\n⚠️ This memory could be strengthened:\n`;

  for (const field of completeness.missing_fields) {
    output += `- Consider adding ${field.field} (${field.reason})\n`;
  }

  output += `\nUse the 'update' tool to add missing fields to this memory.`;

  return output;
}
