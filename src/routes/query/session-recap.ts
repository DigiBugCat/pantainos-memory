/**
 * Session Recap Route - POST /api/session-recap
 *
 * Summarize memories accessed in the current session.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { LoggingEnv } from '../../lib/shared/hono/index.js';
import { callExternalLLM } from '../../lib/embeddings.js';
import { querySessionMemories, type SessionMemoryAccess } from '../../services/access-service.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

function buildRecapPrompt(accesses: SessionMemoryAccess[]): string {
  const memoryList = accesses.map(a => {
    const queries = a.queryTexts.length > 0 ? ` (surfaced by: ${a.queryTexts.join('; ')})` : '';
    return `- [${a.memoryId}] (${a.displayType}, ${a.state}) ${a.content.substring(0, 200)}${a.content.length > 200 ? '...' : ''}${queries}`;
  }).join('\n');

  return `You are summarizing a research session for an AI agent. Below are the memories accessed during this session.

Memories accessed (${accesses.length} total):
${memoryList}

Write a concise session recap (3-5 paragraphs):
1. Identify 2-4 themes or topics explored
2. Note connections between memories where apparent
3. Highlight key findings or patterns
4. Use [ID] notation when referencing specific memories

Be concise and insightful. Focus on what the session revealed, not just what was looked up.`;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body is fine
  }

  const minutes = (body.minutes as number) ?? 30;
  const limit = (body.limit as number) ?? 30;
  const raw = body.raw === true;

  const accesses = await querySessionMemories(c.env.DB, {
    sessionId,
    sinceMinutes: minutes,
    limit,
  });

  if (accesses.length === 0) {
    return c.json({
      success: true,
      count: 0,
      summary: null,
      memory_ids: [],
      raw_accesses: [],
    });
  }

  const memoryIds = accesses.map(a => a.memoryId);

  // Raw mode: skip LLM
  if (raw) {
    return c.json({
      success: true,
      count: accesses.length,
      summary: null,
      memory_ids: memoryIds,
      raw_accesses: accesses.map(a => ({
        memory_id: a.memoryId,
        display_type: a.displayType,
        state: a.state,
        content: a.content.substring(0, 200),
        query_texts: a.queryTexts,
      })),
    });
  }

  // Try LLM summarization
  const prompt = buildRecapPrompt(accesses);

  try {
    let summary: string;

    if (c.env.LLM_JUDGE_URL) {
      summary = await callExternalLLM(
        c.env.LLM_JUDGE_URL,
        prompt,
        { apiKey: c.env.LLM_JUDGE_API_KEY, model: c.env.LLM_JUDGE_MODEL, requestId }
      );
    } else {
      const aiResponse = await c.env.AI.run(
        '@cf/meta/llama-3.1-8b-instruct' as Parameters<typeof c.env.AI.run>[0],
        { messages: [{ role: 'user', content: prompt }] } as { messages: Array<{ role: string; content: string }> }
      ) as { response?: string };
      summary = aiResponse.response || '';
    }

    return c.json({
      success: true,
      count: accesses.length,
      summary: summary || null,
      memory_ids: memoryIds,
    });
  } catch {
    // Fallback to raw
    return c.json({
      success: true,
      count: accesses.length,
      summary: null,
      memory_ids: memoryIds,
      raw_accesses: accesses.map(a => ({
        memory_id: a.memoryId,
        display_type: a.displayType,
        state: a.state,
        content: a.content.substring(0, 200),
        query_texts: a.queryTexts,
      })),
    });
  }
});

export default app;
