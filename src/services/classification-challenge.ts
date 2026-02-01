/**
 * Classification Challenge Service
 *
 * Uses an LLM to analyze whether a memory is correctly classified as
 * an observation or assumption. When enabled via feature toggle, this
 * service challenges potential misclassifications during memory creation.
 *
 * Key insight: The difference between observation and assumption is semantic:
 * - Observations are direct facts from reality (sourced from tools, news, humans, etc.)
 * - Assumptions are derived beliefs that could be wrong
 *
 * When the LLM detects a potential misclassification with sufficient confidence,
 * it returns a challenge that can be included in the response.
 */

import type { Env } from '../types/index.js';
import type { Config } from '../lib/config.js';
import type { ClassificationChallenge, ObservationSource, MemoryType } from '../lib/shared/types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import { withRetry } from '../lib/retry.js';

// Lazy logger - avoids crypto in global scope
let _log: ReturnType<typeof createStandaloneLogger> | null = null;
function getLog() {
  if (!_log) {
    _log = createStandaloneLogger({
      component: 'ClassificationChallenge',
      requestId: 'classification-init',
    });
  }
  return _log;
}

/** JSON schema for classification response */
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    correctly_classified: { type: 'boolean' },
    suggested_type: { type: 'string', enum: ['obs', 'assumption'] },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
  required: ['correctly_classified', 'suggested_type', 'confidence', 'reasoning'],
};

/**
 * Build the prompt for classification analysis.
 */
function buildClassificationPrompt(content: string, currentType: MemoryType): string {
  return `Analyze whether this content is correctly classified as a "${currentType}".

Content: "${content}"

Classification definitions:
- OBSERVATION (obs): Direct facts from reality. Things that were seen, measured, read, or received from external sources. Observations are concrete, specific, and can be verified by pointing to a source (market data, news article, email, tool output, human statement). They should not contain inference or interpretation.

- ASSUMPTION: Beliefs derived from observations. These include interpretations, conclusions, predictions, or inferences. Assumptions are what you THINK based on what you KNOW. They may be wrong and should have falsification conditions.

Key distinguishing questions:
1. Is this a direct report of something observed/received, or an interpretation/conclusion?
2. Could this be directly attributed to a source (market, news, tool, human)?
3. Does this contain words like "suggests", "implies", "means", "will", "should" that indicate inference?

Is this correctly classified as a "${currentType}"?

Respond with JSON only:
{
  "correctly_classified": boolean,
  "suggested_type": "obs" or "assumption",
  "confidence": number between 0 and 1,
  "reasoning": "brief explanation of your assessment"
}`;
}

/**
 * Parse the LLM response for classification analysis.
 */
function parseClassificationResponse(responseText: string): {
  correctly_classified: boolean;
  suggested_type: MemoryType;
  confidence: number;
  reasoning: string;
} | null {
  try {
    // Try direct JSON parse
    const parsed = JSON.parse(responseText);
    if (typeof parsed.correctly_classified === 'boolean' && typeof parsed.confidence === 'number') {
      return {
        correctly_classified: parsed.correctly_classified,
        suggested_type: parsed.suggested_type === 'obs' ? 'obs' : 'assumption',
        confidence: Number(parsed.confidence),
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
      return {
        correctly_classified: Boolean(parsed.correctly_classified),
        suggested_type: parsed.suggested_type === 'obs' ? 'obs' : 'assumption',
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
  _env: Env, // Reserved for future external LLM endpoint support
  ai: Ai,
  config: Config,
  params: {
    content: string;
    current_type: MemoryType;
    requestId?: string;
  }
): Promise<ClassificationChallenge | null> {
  // Check if feature is enabled
  if (!config.classification.challengeEnabled) {
    return null;
  }

  const prompt = buildClassificationPrompt(params.content, params.current_type);

  try {
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
          // GPT-OSS uses Responses API format with structured output
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
          // Chat completion format for other models
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

    const responseText = extractContent(response);
    const result = parseClassificationResponse(responseText);

    if (!result) {
      return null;
    }

    // Only return challenge if:
    // 1. Classification is incorrect according to LLM
    // 2. Confidence is above threshold
    // 3. Suggested type differs from current type
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
        suggested_type: result.suggested_type,
        confidence: result.confidence,
        reasoning: result.reasoning,
      };

      // Add suggested fields based on suggested type
      if (result.suggested_type === 'obs') {
        // Suggest a likely source based on content analysis
        challenge.suggested_fields = {
          source: inferLikelySource(params.content),
        };
      } else {
        // For assumption, we can't automatically determine derived_from
        // User will need to specify these manually
        challenge.suggested_fields = {};
      }

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
function inferLikelySource(content: string): ObservationSource {
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
 */
export function formatChallengeOutput(challenge: ClassificationChallenge, currentType: MemoryType): string {
  const suggestionText = challenge.suggested_type === 'obs' ? 'observation' : 'assumption';
  const currentText = currentType === 'obs' ? 'observation' : 'assumption';

  let output = `\n⚠️ Classification Challenge:\n`;
  output += `This might be better classified as an ${suggestionText} rather than an ${currentText}.\n`;
  output += `Confidence: ${Math.round(challenge.confidence * 100)}%\n`;
  output += `Reasoning: "${challenge.reasoning}"\n`;

  if (challenge.suggested_type === 'obs' && challenge.suggested_fields?.source) {
    output += `\nSuggested source: ${challenge.suggested_fields.source}\n`;
  }

  output += `\nTo reclassify, use: reclassify_as_${challenge.suggested_type === 'obs' ? 'observation' : 'assumption'}`;

  return output;
}
