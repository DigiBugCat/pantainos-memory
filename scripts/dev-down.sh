#!/bin/bash
set -e

# Pantainos Memory - Dev Environment Teardown
# Deletes all Cloudflare resources in the correct order

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Tearing down dev environment..."

# Step 1: Remove queue consumer binding first (breaks the circular dependency)
echo "Removing queue consumer binding..."
wrangler queues consumer remove pantainos-memory-dev-detection pantainos-memory-dev 2>/dev/null || echo "  (consumer not found or already removed)"

# Step 2: Deploy worker WITHOUT queue bindings to fully unbind
echo "Unbinding queue producer from worker..."
cat > "$PROJECT_DIR/unbind.toml" << 'EOF'
name = "pantainos-memory-dev"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

[vars]
REASONING_MODEL = "@cf/openai/gpt-oss-120b"
EOF

# Try to deploy without queue - this may fail if worker doesn't exist, that's OK
wrangler deploy --config "$PROJECT_DIR/unbind.toml" 2>/dev/null || true
rm -f "$PROJECT_DIR/unbind.toml"

# Step 3: Delete queue (now unbound)
echo "Deleting queue..."
echo "y" | wrangler queues delete pantainos-memory-dev-detection 2>/dev/null || echo "  (queue not found or already deleted)"

# Step 4: Delete worker
echo "Deleting worker..."
wrangler delete --name pantainos-memory-dev --force 2>/dev/null || echo "  (worker not found or already deleted)"

# Step 4: Delete D1 database
echo "Deleting D1 database..."
echo "y" | wrangler d1 delete pantainos-memory-dev 2>/dev/null || echo "D1 not found or already deleted"

# Step 5: Delete Vectorize indexes
echo "Deleting Vectorize indexes..."
echo "y" | wrangler vectorize delete pantainos-memory-dev-vectors 2>/dev/null || echo "Vectorize vectors not found"
echo "y" | wrangler vectorize delete pantainos-memory-dev-invalidates 2>/dev/null || echo "Vectorize invalidates not found"
echo "y" | wrangler vectorize delete pantainos-memory-dev-confirms 2>/dev/null || echo "Vectorize confirms not found"

# Step 6: Delete KV namespace
echo "Deleting KV namespace..."
# Get the KV ID from wrangler.toml
KV_ID=$(grep -A2 '\[\[env.dev.kv_namespaces\]\]' wrangler.toml | grep 'id = ' | sed 's/.*id = "\([^"]*\)".*/\1/')
if [[ -n "$KV_ID" && "$KV_ID" != "TODO" ]]; then
  echo "y" | wrangler kv namespace delete --namespace-id="$KV_ID" 2>/dev/null || echo "KV not found or already deleted"
else
  echo "KV namespace ID not found in wrangler.toml"
fi

# Step 7: Reset wrangler.toml IDs to TODO
echo "Resetting wrangler.toml resource IDs..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' 's/database_id = "[a-f0-9-]*"/database_id = "TODO"/' wrangler.toml
  # Reset KV ID in dev section
  sed -i '' '/\[\[env.dev.kv_namespaces\]\]/,/^id = "[a-f0-9-]*"$/{s/id = "[a-f0-9-]*"/id = "TODO"/;}' wrangler.toml
else
  sed -i 's/database_id = "[a-f0-9-]*"/database_id = "TODO"/' wrangler.toml
  sed -i '/\[\[env.dev.kv_namespaces\]\]/,/^id = "[a-f0-9-]*"$/{s/id = "[a-f0-9-]*"/id = "TODO"/;}' wrangler.toml
fi

echo ""
echo "==> Dev environment torn down!"
