-- Reset script: Drop all tables for clean slate deployment
-- Usage: npx wrangler d1 execute <db-name> --remote --file=migrations/reset.sql
-- Then:  npx wrangler d1 execute <db-name> --remote --file=migrations/schema.sql

DROP TABLE IF EXISTS experiment_aggregates;
DROP TABLE IF EXISTS experiment_case_results;
DROP TABLE IF EXISTS experiment_runs;
DROP TABLE IF EXISTS entity_versions;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS memory_events;
DROP TABLE IF EXISTS access_events;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS memories;
