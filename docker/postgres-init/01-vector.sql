-- Bootstraps the pgvector extension on a pristine database (docker-entrypoint-initdb.d
-- runs once at first init; existing deployments already have it).
-- Interim until plan 03's versioned migrations own all DDL — see the runtime
-- ensureNarrativeStorage DDL in apps/worker that this replaces for fresh installs.
CREATE EXTENSION IF NOT EXISTS vector;
