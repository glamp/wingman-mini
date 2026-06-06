#!/usr/bin/env bash
# Package the extension into wingman.zip for Chrome Web Store upload.
# No build step — just zip the runtime files with manifest.json at the root.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -f wingman.zip
zip -r wingman.zip manifest.json src icons -x '*.DS_Store'

echo "Created wingman.zip:"
unzip -l wingman.zip
