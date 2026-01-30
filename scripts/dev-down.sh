#!/bin/bash
set -e

# Pantainos Memory - Dev Environment Teardown
# Deletes all Cloudflare resources in the correct order

echo "==> Tearing down dev environment..."

# Step 1: Deploy worker WITHOUT queue bindings to break the circular dependency
echo "Unbinding queue from worker..."
cat > /tmp/pantainos-unbind.toml << 'EOF'
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
wrangler deploy --config /tmp/pantainos-unbind.toml 2>/dev/null || true
rm /tmp/pantainos-unbind.toml

# Step 2: Delete queue (now unbound)
echo "Deleting queue..."
echo "y" | wrangler queues delete pantainos-memory-dev-detection 2>/dev/null || echo "Queue not found or already deleted"

# Step 3: Delete worker
echo "Deleting worker..."
wrangler delete --name pantainos-memory-dev --force 2>/dev/null || echo "Worker not found or already deleted"

# Step 4: Delete D1 database
echo "Deleting D1 database..."
echo "y" | wrangler d1 delete pantainos-memory-dev 2>/dev/null || echo "D1 not found or already deleted"

# Step 5: Delete KV namespace (need to find ID first)
echo "Deleting KV namespace..."
KV_ID=$(wrangler kv namespace list 2>/dev/null | grep -A1 "dev-OAUTH_KV" | grep "│" | head -1 | awk -F'│' '{print $2}' | tr -d ' ' || true)
if [ -n "$KV_ID" ]; then
  echo "y" | wrangler kv namespace delete --namespace-id "$KV_ID" 2>/dev/null || echo "KV delete failed"
else
  echo "KV namespace not found or already deleted"
fi

# Step 6: Delete Vectorize indexes
echo "Deleting Vectorize indexes..."
echo "y" | wrangler vectorize delete pantainos-memory-dev-vectors 2>/dev/null || echo "Vectorize vectors not found"
echo "y" | wrangler vectorize delete pantainos-memory-dev-invalidates 2>/dev/null || echo "Vectorize invalidates not found"
echo "y" | wrangler vectorize delete pantainos-memory-dev-confirms 2>/dev/null || echo "Vectorize confirms not found"

# Step 7: Reset wrangler.toml IDs to TODO
echo "Resetting wrangler.toml resource IDs..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS - reset dev environment IDs
  sed -i '' 's/database_id = "[a-f0-9-]*"/database_id = "TODO"/' wrangler.toml
  # Only reset the dev KV ID (second occurrence after env.dev section)
  # This is tricky, so we'll just note it needs manual reset if needed
else
  sed -i 's/database_id = "[a-f0-9-]*"/database_id = "TODO"/' wrangler.toml
fi

echo ""
echo "==> Dev environment torn down!"
echo ""
echo "Note: You may need to manually reset the KV namespace ID in wrangler.toml"
echo "      under [env.dev] section to 'TODO' if you plan to recreate."
