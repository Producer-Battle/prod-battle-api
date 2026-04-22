#!/usr/bin/env bash
# Publishes the OpenAPI spec as an npm package so prod-battle-web can depend
# on a versioned contract and regenerate its TS client from
# `@producer-battle/prod-battle-api`.
#
# Runs in CI after `pnpm openapi:emit`.

set -euo pipefail

PKG_DIR=$(mktemp -d)
cp openapi.json "$PKG_DIR/"
cat > "$PKG_DIR/package.json" <<JSON
{
  "name": "@producer-battle/prod-battle-api",
  "version": "0.0.0-$(git rev-parse --short HEAD)",
  "files": ["openapi.json"],
  "main": "openapi.json",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com/"
  }
}
JSON

cd "$PKG_DIR"
echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" > .npmrc
npm publish --access restricted
