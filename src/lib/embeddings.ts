import type { Env } from '../types/index.js';
import type { Config } from './config.js';
import { createLazyLogger } from './lazy-logger.js';
import { defaultConfig } from './config.js';
import { EmbeddingError, VectorStoreError } from './errors.js';
import { withRetry } from './retry.js';

const getLog = createLazyLogger('Embeddings', 'embed-init');

/**
 * Get AI Gateway options for Workers AI calls.
 * Returns undefined if gateway not configured (allows graceful degradation in dev).
 */
function getGatewayOptions(config: Config): { gateway: { id: string } } | undefined {
  if (!config.aiGatewayId) {
    return undefined;
  }
  return { gateway: { id: config.aiGatewayId } };
}

/**
 * Call external LLM endpoint (OpenAI-compatible).
 * Used when LLM_JUDGE_URL is configured to route LLM calls through n8n or other services.
 */
async function callExternalLLM(
  url: string,
  prompt: string,
  apiKey?: string,
  requestId?: string
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  if (requestId) {
    headers['X-Request-Id'] = requestId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'default', // Let the endpoint decide the model
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`External LLM call failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    content?: string;
    response?: string;
    result?: string;
  };

  // Handle various response formats
  const content = data.choices?.[0]?.message?.content
    || data.content
    || data.response
    || data.result;

  if (!content) {
    throw new Error('No content in external LLM response');
  }

  return content;
}

/**
 * Generate embedding for text using configured model.
 * Includes retry logic for transient AI service failures.
 */
export async function generateEmbedding(
  ai: Ai,
  text: string,
  config: Config = defaultConfig,
  requestId?: string
): Promise<number[]> {
  return withRetry(
    async () => {
      const response = await ai.run(
        config.embeddingModel as Parameters<typeof ai.run>[0],
        { text },
        getGatewayOptions(config)
      ) as { data: number[][] };

      if (!response.data || response.data.length === 0) {
        throw new EmbeddingError('Empty embedding response');
      }

      return response.data[0];
    },
    { retries: 2, delay: 100, name: 'generateEmbedding', requestId }
  );
}

export interface DuplicateCheckResult {
  id: string | null;
  similarity: number;
}

/**
 * Check for duplicate memory using vector similarity.
 * Returns match info including similarity score for two-phase dedup.
 */
export async function checkDuplicate(
  env: Env,
  embedding: number[],
  requestId?: string
): Promise<DuplicateCheckResult> {
  let results;
  try {
    results = await withRetry(
      () => env.MEMORY_VECTORS.query(embedding, { topK: 1, returnMetadata: 'all' }),
      { retries: 2, delay: 100, name: 'checkDuplicate', requestId }
    );
  } catch (error) {
    throw new VectorStoreError(
      `Duplicate check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  if (results.matches.length > 0) {
    const match = results.matches[0];
    return {
      id: match.id,
      similarity: match.score,
    };
  }

  return { id: null, similarity: 0 };
}

export interface LLMDuplicateResult {
  isDuplicate: boolean;
  confidence: number;
  reasoning: string;
}

/**
 * Use LLM to determine if two memories are duplicates.
 * Called for borderline embedding similarity cases (0.70-0.85).
 * If LLM_JUDGE_URL is configured, routes to external endpoint instead of Workers AI.
 */
export async function checkDuplicateWithLLM(
  ai: Ai,
  contentA: string,
  contentB: string,
  config: Config,
  requestId?: string,
  env?: Env
): Promise<LLMDuplicateResult> {
  const prompt = `Two memories are duplicates ONLY if they record the SAME insight about the SAME specific person/topic. Related themes don't count.

Memory A: ${contentA}

Memory B: ${contentB}

Respond with ONLY a JSON object (no markdown, no explanation): {"verdict": "duplicate" or "distinct", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

  let responseContent: string;

  // Use external LLM endpoint if configured
  if (env?.LLM_JUDGE_URL) {
    responseContent = await withRetry(
      () => callExternalLLM(env.LLM_JUDGE_URL!, prompt, env.LLM_JUDGE_API_KEY, requestId),
      { retries: 2, delay: 100, name: 'checkDuplicateWithLLM_external', requestId }
    );
  } else {
    // Use Workers AI
    const model = config.dedupModel;

    // gpt-oss response type
    interface GptOssResponse {
      output?: Array<{
        type: string;
        content?: Array<{
          text?: string;
          type?: string;
        }>;
      }>;
      response?: string;
    }

    const response = await withRetry(
      async () => {
        const result = await ai.run(
          model as Parameters<typeof ai.run>[0],
          { input: prompt } as { input: string },
          getGatewayOptions(config)
        ) as GptOssResponse;
        return result;
      },
      { retries: 2, delay: 100, name: 'checkDuplicateWithLLM', requestId }
    );

    // Extract content from Workers AI response
    if (response.output && Array.isArray(response.output)) {
      const messageOutput = response.output.find(o => o.type === 'message');
      if (messageOutput?.content?.[0]?.text) {
        responseContent = messageOutput.content[0].text;
      }
    }
    if (!responseContent! && response.response) {
      responseContent = response.response;
    }
    if (!responseContent!) {
      throw new Error('No content in LLM response');
    }
  }

  try {
    let content = responseContent.trim();

    // Handle markdown code blocks if present
    if (content.includes('```')) {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        content = match[1].trim();
      }
    }

    // Try to extract JSON from the response if it's mixed with text
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      content = jsonMatch[0];
    }

    const parsed = JSON.parse(content);
    return {
      isDuplicate: parsed.verdict === 'duplicate',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning || '',
    };
  } catch (e) {
    // Log the raw response for debugging
    getLog().error('llm_parse_failed', {
      response_preview: responseContent.substring(0, 500),
      error: (e as Error).message,
    });
    return {
      isDuplicate: false,
      confidence: 0,
      reasoning: `Failed to parse LLM response: ${(e as Error).message}`,
    };
  }
}

/**
 * Search for similar memories.
 * Includes retry logic for transient Vectorize failures.
 */
export async function searchSimilar(
  env: Env,
  embedding: number[],
  topK: number = 50,
  minSimilarity: number = 0,
  requestId?: string
): Promise<{ id: string; similarity: number }[]> {
  let results;
  try {
    results = await withRetry(
      () => env.MEMORY_VECTORS.query(embedding, { topK, returnMetadata: 'all' }),
      { retries: 2, delay: 100, name: 'searchSimilar', requestId }
    );
  } catch (error) {
    throw new VectorStoreError(
      `Vector search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  return results.matches
    .filter(m => m.score >= minSimilarity)
    .map(m => ({
      id: m.id,
      similarity: m.score,
    }));
}
