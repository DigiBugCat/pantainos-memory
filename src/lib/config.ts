/**
 * Configuration module - all tunable parameters
 * Values can be overridden via environment variables in wrangler.toml
 */

import { createLazyLogger } from './lazy-logger.js';

const getLog = createLazyLogger('Config');

export interface Config {
  // Models
  embeddingModel: string;
  reasoningModel: string;

  // AI Gateway (for observability)
  aiGatewayId: string | null;

  // Deduplication
  dedupThreshold: number;
  dedupLowerThreshold: number;
  dedupModel: string;
  dedupConfidenceThreshold: number;
  combineDedupThreshold: number;

  // Scoring weights
  scoring: {
    recencyWeight: number;
    frequencyWeight: number;
    importanceWeight: number;
    connectivityWeight: number;
    connectivityNormalizer: number;
    timeDecayHalfLifeDays: number;
    frequencyMedian: number;
    frequencyK: number;
  };

  // Robustness thresholds (for confidence tier calculation)
  robustness: {
    /** Below this many times_tested = untested (default: 3) */
    untestedMaxTimesTested: number;
    /** Below this many times_tested = brittle (default: 10) */
    brittleMaxTimesTested: number;
    /** Above this confidence = robust when well-tested (default: 0.7) */
    robustMinConfidence: number;
  };

  // Cleanup
  accessLogRetentionDays: number;

  // Search defaults
  search: {
    defaultLimit: number;
    minSimilarity: number;
    candidateMultiplier: number;
  };

  // Bulk operation limits
  bulk: {
    maxCreateBatch: number;
    maxDeleteBatch: number;
    maxConnectBatch: number;
    maxCombineBatch: number;
  };

  // Classification challenge (AI-powered type checking)
  classification: {
    /** Enable AI-powered classification challenges (default: false) */
    challengeEnabled: boolean;
    /** Model to use for classification analysis */
    challengeModel: string;
    /** Confidence threshold to trigger challenge (0-1, default: 0.7) */
    challengeThreshold: number;
  };
}

/**
 * Parse a number from string with validation and bounds checking
 * @param value - String value from env
 * @param defaultVal - Default if value is undefined or invalid
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @param name - Config name for warning messages
 */
function parseNumber(
  value: string | undefined,
  defaultVal: number,
  min: number,
  max: number,
  name?: string
): number {
  if (!value) return defaultVal;

  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    if (name) getLog().warn('invalid_config_value', { name, value, default: defaultVal });
    return defaultVal;
  }

  if (parsed < min || parsed > max) {
    const clamped = Math.max(min, Math.min(max, parsed));
    if (name) getLog().warn('config_out_of_bounds', { name, value: parsed, min, max, clamped });
    return clamped;
  }

  return parsed;
}

/**
 * Parse an integer from string with validation and bounds checking
 */
function parseInt_(
  value: string | undefined,
  defaultVal: number,
  min: number,
  max: number,
  name?: string
): number {
  if (!value) return defaultVal;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    if (name) getLog().warn('invalid_config_value', { name, value, default: defaultVal });
    return defaultVal;
  }

  if (parsed < min || parsed > max) {
    const clamped = Math.max(min, Math.min(max, parsed));
    if (name) getLog().warn('config_out_of_bounds', { name, value: parsed, min, max, clamped });
    return clamped;
  }

  return parsed;
}

/**
 * Get configuration from environment variables with defaults and validation
 */
export function getConfig(env: Record<string, string | undefined>): Config {
  return {
    // Models (strings - just validate non-empty)
    embeddingModel: env.EMBEDDING_MODEL || '@cf/google/embeddinggemma-300m',
    reasoningModel: env.REASONING_MODEL || '@cf/openai/gpt-oss-120b',

    // AI Gateway (optional - for observability)
    aiGatewayId: env.AI_GATEWAY_ID || null,

    // Deduplication (similarity thresholds: 0.0 - 1.0)
    dedupThreshold: parseNumber(env.DEDUP_THRESHOLD, 0.85, 0.5, 1.0, 'DEDUP_THRESHOLD'),
    dedupLowerThreshold: parseNumber(env.DEDUP_LOWER_THRESHOLD, 0.70, 0.3, 0.9, 'DEDUP_LOWER_THRESHOLD'),
    dedupModel: env.DEDUP_MODEL || '@cf/openai/gpt-oss-20b',
    dedupConfidenceThreshold: parseNumber(env.DEDUP_CONFIDENCE_THRESHOLD, 0.8, 0.5, 1.0, 'DEDUP_CONFIDENCE_THRESHOLD'),
    combineDedupThreshold: parseNumber(env.COMBINE_DEDUP_THRESHOLD, 0.95, 0.5, 1.0, 'COMBINE_DEDUP_THRESHOLD'),

    // Scoring weights (0.0 - 2.0 to allow flexibility)
    scoring: {
      recencyWeight: parseNumber(env.SCORING_RECENCY_WEIGHT, 0.3, 0, 2.0, 'SCORING_RECENCY_WEIGHT'),
      frequencyWeight: parseNumber(env.SCORING_FREQUENCY_WEIGHT, 0.3, 0, 2.0, 'SCORING_FREQUENCY_WEIGHT'),
      importanceWeight: parseNumber(env.SCORING_IMPORTANCE_WEIGHT, 0.4, 0, 2.0, 'SCORING_IMPORTANCE_WEIGHT'),
      connectivityWeight: parseNumber(env.SCORING_CONNECTIVITY_WEIGHT, 0.3, 0, 2.0, 'SCORING_CONNECTIVITY_WEIGHT'),
      connectivityNormalizer: parseNumber(env.SCORING_CONNECTIVITY_NORMALIZER, 10, 1, 100, 'SCORING_CONNECTIVITY_NORMALIZER'),
      timeDecayHalfLifeDays: parseInt_(env.TIME_DECAY_HALF_LIFE_DAYS, 30, 1, 365, 'TIME_DECAY_HALF_LIFE_DAYS'),
      frequencyMedian: parseNumber(env.FREQUENCY_MEDIAN, 3, 1, 100, 'FREQUENCY_MEDIAN'),
      frequencyK: parseNumber(env.FREQUENCY_K, 2, 0.1, 10, 'FREQUENCY_K'),
    },

    // Robustness thresholds (for confidence tier calculation)
    robustness: {
      untestedMaxTimesTested: parseInt_(env.ROBUSTNESS_UNTESTED_MAX_TIMES_TESTED, 3, 1, 20, 'ROBUSTNESS_UNTESTED_MAX_TIMES_TESTED'),
      brittleMaxTimesTested: parseInt_(env.ROBUSTNESS_BRITTLE_MAX_TIMES_TESTED, 10, 3, 50, 'ROBUSTNESS_BRITTLE_MAX_TIMES_TESTED'),
      robustMinConfidence: parseNumber(env.ROBUSTNESS_ROBUST_MIN_CONFIDENCE, 0.7, 0.3, 1.0, 'ROBUSTNESS_ROBUST_MIN_CONFIDENCE'),
    },

    // Cleanup (1 day to 1 year)
    accessLogRetentionDays: parseInt_(env.ACCESS_LOG_RETENTION_DAYS, 7, 1, 365, 'ACCESS_LOG_RETENTION_DAYS'),

    // Search
    search: {
      defaultLimit: parseInt_(env.SEARCH_DEFAULT_LIMIT, 10, 1, 100, 'SEARCH_DEFAULT_LIMIT'),
      minSimilarity: parseNumber(env.SEARCH_MIN_SIMILARITY, 0, 0, 1.0, 'SEARCH_MIN_SIMILARITY'),
      candidateMultiplier: parseInt_(env.SEARCH_CANDIDATE_MULTIPLIER, 5, 1, 20, 'SEARCH_CANDIDATE_MULTIPLIER'),
    },

    // Bulk limits (reasonable bounds to prevent abuse)
    bulk: {
      maxCreateBatch: parseInt_(env.BULK_MAX_CREATE, 100, 1, 1000, 'BULK_MAX_CREATE'),
      maxDeleteBatch: parseInt_(env.BULK_MAX_DELETE, 100, 1, 1000, 'BULK_MAX_DELETE'),
      maxConnectBatch: parseInt_(env.BULK_MAX_CONNECT, 20, 2, 100, 'BULK_MAX_CONNECT'),
      maxCombineBatch: parseInt_(env.BULK_MAX_COMBINE, 10, 2, 50, 'BULK_MAX_COMBINE'),
    },

    // Classification challenge (AI-powered type checking)
    classification: {
      challengeEnabled: env.CLASSIFICATION_CHALLENGE_ENABLED === 'true',
      challengeModel: env.CLASSIFICATION_CHALLENGE_MODEL || '@cf/openai/gpt-oss-20b',
      challengeThreshold: parseNumber(env.CLASSIFICATION_CHALLENGE_THRESHOLD, 0.7, 0.3, 1.0, 'CLASSIFICATION_CHALLENGE_THRESHOLD'),
    },
  };
}

/**
 * Default config for when env is not available
 */
export const defaultConfig: Config = getConfig({});
