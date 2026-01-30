#!/bin/bash
set -e

# Pantainos Memory - Dev Environment Setup
# Creates all Cloudflare resources and deploys the worker

echo "==> Creating dev environment resources..."

# Create D1 database
echo "Creating D1 database..."
D1_OUTPUT=$(wrangler d1 create pantainos-memory-dev 2>&1)
D1_ID=$(echo "$D1_OUTPUT" | grep "database_id" | sed 's/.*database_id = "\([^"]*\)".*/\1/')
echo "D1 database ID: $D1_ID"

# Create KV namespace
echo "Creating KV namespace..."
KV_OUTPUT=$(wrangler kv namespace create OAUTH_KV --env dev 2>&1)
KV_ID=$(echo "$KV_OUTPUT" | grep "^id = " | sed 's/id = "\([^"]*\)"/\1/')
echo "KV namespace ID: $KV_ID"

# Create Vectorize indexes (768 dimensions for embeddinggemma-300m)
echo "Creating Vectorize indexes..."
wrangler vectorize create pantainos-memory-dev-vectors --dimensions=768 --metric=cosine
wrangler vectorize create pantainos-memory-dev-invalidates --dimensions=768 --metric=cosine
wrangler vectorize create pantainos-memory-dev-confirms --dimensions=768 --metric=cosine

# Create Queue
echo "Creating Queue..."
wrangler queues create pantainos-memory-dev-detection

# Update wrangler.toml with new IDs
echo "Updating wrangler.toml with resource IDs..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  sed -i '' "s/database_id = \"TODO\"/database_id = \"$D1_ID\"/" wrangler.toml
  sed -i '' "s/id = \"TODO\"/id = \"$KV_ID\"/" wrangler.toml
else
  # Linux
  sed -i "s/database_id = \"TODO\"/database_id = \"$D1_ID\"/" wrangler.toml
  sed -i "s/id = \"TODO\"/id = \"$KV_ID\"/" wrangler.toml
fi

# Run migration
echo "Running database migration..."
wrangler d1 execute pantainos-memory-dev --remote --file=migrations/schema.sql

# Deploy
echo "Deploying worker..."
wrangler deploy --env dev

echo ""
echo "==> Dev environment ready!"
echo "URL: https://pantainos-memory-dev.pantainos.workers.dev"
echo ""
echo "Resources created:"
echo "  D1:        $D1_ID"
echo "  KV:        $KV_ID"
echo "  Vectorize: pantainos-memory-dev-vectors (768d)"
echo "  Vectorize: pantainos-memory-dev-invalidates (768d)"
echo "  Vectorize: pantainos-memory-dev-confirms (768d)"
echo "  Queue:     pantainos-memory-dev-detection"
