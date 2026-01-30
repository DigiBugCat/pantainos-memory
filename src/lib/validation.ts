import { ValidationError } from './errors.js';
import type { Config } from './config.js';

const MAX_CONTENT_LENGTH = 10000; // 10KB default
const MAX_TAG_LENGTH = 100;
const MAX_TAGS_COUNT = 50;
const MAX_EDGE_STRENGTH = 100;
const MIN_EDGE_STRENGTH = 0.01;
const MAX_ID_LENGTH = 50;

/**
 * Validate memory ID format
 */
export function validateMemoryId(id: unknown, fieldName = 'id'): string {
  if (typeof id !== 'string') {
    throw new ValidationError(`${fieldName} must be a string`);
  }
  if (id.length === 0) {
    throw new ValidationError(`${fieldName} is required`);
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new ValidationError(`${fieldName} too long (max ${MAX_ID_LENGTH} chars)`);
  }
  // Only allow alphanumeric, underscore, hyphen (nanoid format)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new ValidationError(`${fieldName} contains invalid characters`);
  }
  return id;
}

/**
 * Validate content string
 */
export function validateContent(content: unknown): string {
  if (content === undefined || content === null) {
    throw new ValidationError('Content is required');
  }
  if (typeof content !== 'string') {
    throw new ValidationError('Content must be a string');
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Content cannot be empty');
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new ValidationError(`Content too long (max ${MAX_CONTENT_LENGTH} chars)`);
  }
  return trimmed;
}

/**
 * Validate tags array
 */
export function validateTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) {
    return [];
  }
  if (!Array.isArray(tags)) {
    throw new ValidationError('Tags must be an array');
  }
  if (tags.length > MAX_TAGS_COUNT) {
    throw new ValidationError(`Too many tags (max ${MAX_TAGS_COUNT})`);
  }
  const validated: string[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (typeof tag !== 'string') {
      throw new ValidationError(`Tag at index ${i} must be a string`);
    }
    const trimmed = tag.trim();
    if (trimmed.length === 0) {
      continue; // Skip empty tags
    }
    if (trimmed.length > MAX_TAG_LENGTH) {
      throw new ValidationError(`Tag "${trimmed.slice(0, 20)}..." too long (max ${MAX_TAG_LENGTH} chars)`);
    }
    validated.push(trimmed);
  }
  return [...new Set(validated)]; // Dedupe
}

/**
 * Validate edge strength
 */
export function validateStrength(strength: unknown): number | undefined {
  if (strength === undefined || strength === null) {
    return undefined;
  }
  if (typeof strength !== 'number') {
    throw new ValidationError('Strength must be a number');
  }
  if (!Number.isFinite(strength)) {
    throw new ValidationError('Strength must be a finite number');
  }
  if (strength < MIN_EDGE_STRENGTH) {
    throw new ValidationError(`Strength must be at least ${MIN_EDGE_STRENGTH}`);
  }
  if (strength > MAX_EDGE_STRENGTH) {
    throw new ValidationError(`Strength cannot exceed ${MAX_EDGE_STRENGTH}`);
  }
  return strength;
}

/**
 * Validate edge strength delta (for strengthen/weaken)
 */
export function validateDelta(delta: unknown): number {
  if (delta === undefined || delta === null) {
    return 1.0; // Default
  }
  if (typeof delta !== 'number') {
    throw new ValidationError('Delta must be a number');
  }
  if (!Number.isFinite(delta)) {
    throw new ValidationError('Delta must be a finite number');
  }
  if (delta <= 0) {
    throw new ValidationError('Delta must be positive');
  }
  if (delta > MAX_EDGE_STRENGTH) {
    throw new ValidationError(`Delta cannot exceed ${MAX_EDGE_STRENGTH}`);
  }
  return delta;
}

/**
 * Validate related IDs for note creation (max 10)
 */
export function validateRelatedIds(
  ids: unknown,
  fieldName = 'related_ids'
): string[] | undefined {
  if (ids === undefined || ids === null) {
    return undefined;
  }
  if (!Array.isArray(ids)) {
    throw new ValidationError(`${fieldName} must be an array`);
  }
  if (ids.length > 10) {
    throw new ValidationError(`Maximum 10 ${fieldName} allowed`);
  }
  const validated = ids.map((id, i) => validateMemoryId(id, `${fieldName}[${i}]`));

  // Check for duplicates
  const unique = [...new Set(validated)];
  if (unique.length !== validated.length) {
    throw new ValidationError(`Duplicate ${fieldName} provided`);
  }

  return validated;
}

/**
 * Validate search query
 */
export function validateSearchQuery(query: unknown): string {
  if (query === undefined || query === null) {
    throw new ValidationError('Query is required');
  }
  if (typeof query !== 'string') {
    throw new ValidationError('Query must be a string');
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('Query cannot be empty');
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    throw new ValidationError(`Query too long (max ${MAX_CONTENT_LENGTH} chars)`);
  }
  return trimmed;
}

/**
 * Validate limit parameter
 */
export function validateLimit(limit: unknown, defaultVal: number, max: number = 100): number {
  if (limit === undefined || limit === null) {
    return defaultVal;
  }
  const parsed = typeof limit === 'string' ? parseInt(limit, 10) : limit;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new ValidationError('Limit must be an integer');
  }
  if (parsed < 1) {
    throw new ValidationError('Limit must be at least 1');
  }
  return Math.min(parsed, max);
}

/**
 * Validate offset parameter
 */
export function validateOffset(offset: unknown): number {
  if (offset === undefined || offset === null) {
    return 0;
  }
  const parsed = typeof offset === 'string' ? parseInt(offset, 10) : offset;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new ValidationError('Offset must be an integer');
  }
  if (parsed < 0) {
    throw new ValidationError('Offset cannot be negative');
  }
  return parsed;
}

/**
 * Validate minimum similarity threshold
 */
export function validateMinSimilarity(minSimilarity: unknown, defaultVal: number = 0): number {
  if (minSimilarity === undefined || minSimilarity === null) {
    return defaultVal;
  }
  if (typeof minSimilarity !== 'number') {
    throw new ValidationError('min_similarity must be a number');
  }
  if (!Number.isFinite(minSimilarity)) {
    throw new ValidationError('min_similarity must be a finite number');
  }
  if (minSimilarity < 0 || minSimilarity > 1) {
    throw new ValidationError('min_similarity must be between 0 and 1');
  }
  return minSimilarity;
}

/**
 * Validate memory IDs array
 */
export function validateMemoryIds(
  ids: unknown,
  config: Config,
  fieldName = 'memory_ids',
  minCount = 1
): string[] {
  if (!Array.isArray(ids)) {
    throw new ValidationError(`${fieldName} must be an array`);
  }
  if (ids.length < minCount) {
    throw new ValidationError(`At least ${minCount} ${fieldName} required`);
  }
  const validated = ids.map((id, i) => validateMemoryId(id, `${fieldName}[${i}]`));

  // Check for duplicates
  const unique = [...new Set(validated)];
  if (unique.length !== validated.length) {
    throw new ValidationError(`Duplicate ${fieldName} provided`);
  }

  return validated;
}

/**
 * Validated create memory request
 */
export interface ValidatedCreateMemoryRequest {
  content: string;
  tags: string[];
  related_ids?: string[];
}

/**
 * Validate create memory request body
 */
export function validateCreateMemoryRequest(body: unknown): ValidatedCreateMemoryRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Invalid request body');
  }
  const { content, tags, related_ids } = body as Record<string, unknown>;

  return {
    content: validateContent(content),
    tags: validateTags(tags),
    related_ids: validateRelatedIds(related_ids),
  };
}

/**
 * Validated update memory request
 */
export interface ValidatedUpdateMemoryRequest {
  content?: string;
  tags?: string[];
}

/**
 * Validate update memory request body
 */
export function validateUpdateMemoryRequest(body: unknown): ValidatedUpdateMemoryRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Invalid request body');
  }
  const { content, tags } = body as Record<string, unknown>;

  const result: ValidatedUpdateMemoryRequest = {};

  if (content !== undefined) {
    result.content = validateContent(content);
  }
  if (tags !== undefined) {
    result.tags = validateTags(tags);
  }

  return result;
}

/**
 * Validated search request
 */
export interface ValidatedSearchRequest {
  query: string;
  limit: number;
  min_similarity: number;
}

/**
 * Validate search request body
 */
export function validateSearchRequest(body: unknown, config: Config): ValidatedSearchRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Invalid request body');
  }
  const { query, limit, min_similarity } = body as Record<string, unknown>;

  return {
    query: validateSearchQuery(query),
    limit: validateLimit(limit, config.search.defaultLimit, 100),
    min_similarity: validateMinSimilarity(min_similarity, config.search.minSimilarity),
  };
}

/**
 * Validated create edge request
 */
export interface ValidatedCreateEdgeRequest {
  source_id: string;
  target_id: string;
  strength: number;
}

/**
 * Validate create edge request body
 */
export function validateCreateEdgeRequest(body: unknown): ValidatedCreateEdgeRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Invalid request body');
  }
  const { source_id, target_id, strength } = body as Record<string, unknown>;

  const validatedSourceId = validateMemoryId(source_id, 'source_id');
  const validatedTargetId = validateMemoryId(target_id, 'target_id');

  if (validatedSourceId === validatedTargetId) {
    throw new ValidationError('source_id and target_id must be different');
  }

  return {
    source_id: validatedSourceId,
    target_id: validatedTargetId,
    strength: validateStrength(strength) ?? 1.0,
  };
}
