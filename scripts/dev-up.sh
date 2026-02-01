#!/bin/bash
set -e

# Pantainos Memory - Dev Environment Setup
# Creates all Cloudflare resources and deploys the worker
# Handles already-existing resources gracefully

echo "==> Creating dev environment resources..."

# Create D1 database (or get existing ID)
echo "Creating D1 database..."
D1_OUTPUT=$(wrangler d1 create memory-dev 2>&1) || true
if echo "$D1_OUTPUT" | grep -q "already exists"; then
  echo "D1 database already exists, fetching ID..."
  D1_ID=$(wrangler d1 list 2>&1 | grep -A1 "memory-dev" | grep -o '[a-f0-9-]\{36\}' | head -1)
else
  D1_ID=$(echo "$D1_OUTPUT" | grep "database_id" | sed 's/.*database_id = "\([^"]*\)".*/\1/')
fi
echo "D1 database ID: $D1_ID"

# Create Vectorize indexes (768 dimensions for embeddinggemma-300m)
echo "Creating Vectorize indexes..."
wrangler vectorize create memory-dev-vectors --dimensions=768 --metric=cosine 2>&1 || echo "  (already exists)"
wrangler vectorize create memory-dev-invalidates --dimensions=768 --metric=cosine 2>&1 || echo "  (already exists)"
wrangler vectorize create memory-dev-confirms --dimensions=768 --metric=cosine 2>&1 || echo "  (already exists)"

# Create Queue
echo "Creating Queue..."
wrangler queues create memory-dev-detection 2>&1 || echo "  (already exists)"

# Create KV namespace for OAuth (or get existing ID)
echo "Creating KV namespace..."
KV_OUTPUT=$(wrangler kv namespace create "memory-dev-oauth" 2>&1) || true
if echo "$KV_OUTPUT" | grep -q "already exists"; then
  echo "KV namespace already exists, fetching ID..."
  KV_ID=$(wrangler kv namespace list 2>&1 | grep -B2 "memory-dev-oauth" | grep '"id"' | sed 's/.*"id": "\([^"]*\)".*/\1/')
else
  KV_ID=$(echo "$KV_OUTPUT" | grep '"id":' | sed 's/.*"id": "\([^"]*\)".*/\1/')
fi
echo "KV namespace ID: $KV_ID"

# Update wrangler.toml with new IDs
echo "Updating wrangler.toml with resource IDs..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS
  sed -i '' "s/database_id = \"TODO\"/database_id = \"$D1_ID\"/" wrangler.toml
  # Update KV ID in dev section (find the one after env.dev.kv_namespaces)
  sed -i '' "/\[\[env.dev.kv_namespaces\]\]/,/^id = \"TODO\"$/{s/id = \"TODO\"/id = \"$KV_ID\"/;}" wrangler.toml
else
  # Linux
  sed -i "s/database_id = \"TODO\"/database_id = \"$D1_ID\"/" wrangler.toml
  sed -i "/\[\[env.dev.kv_namespaces\]\]/,/^id = \"TODO\"$/{s/id = \"TODO\"/id = \"$KV_ID\"/;}" wrangler.toml
fi

# Run migration
echo "Running database migration..."
wrangler d1 execute memory-dev --remote --file=migrations/schema.sql

# Deploy
echo "Deploying worker..."
wrangler deploy --env dev

echo ""
echo "==> Dev environment ready!"
echo "URL: https://memory-dev.pantainos.workers.dev"
echo ""
echo "Resources created:"
echo "  D1:        $D1_ID"
echo "  KV:        $KV_ID"
echo "  Vectorize: memory-dev-vectors (768d)"
echo "  Vectorize: memory-dev-invalidates (768d)"
echo "  Vectorize: memory-dev-confirms (768d)"
echo "  Queue:     memory-dev-detection"
