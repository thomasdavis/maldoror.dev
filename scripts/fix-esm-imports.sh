#!/bin/bash
# Fix ESM imports in dist files
# TypeScript doesn't add .js extensions but Node ESM requires them
# This script adds .js to all relative imports in compiled JS files

set -e

echo "Fixing ESM imports in packages..."

for f in $(find /var/www/maldoror.dev/packages -name "*.js" -path "*/dist/*" 2>/dev/null || find packages -name "*.js" -path "*/dist/*"); do
    # Step 1: Add .js to all relative imports
    sed -i "s/from '\\.\\/\\([^']*\\)'/from '.\\/\\1.js'/g" "$f"
    # Step 2: Fix double .js.js -> .js
    sed -i "s/\\.js\\.js'/.js'/g" "$f"
done

echo "ESM imports fixed!"
