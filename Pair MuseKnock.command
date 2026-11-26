#!/bin/zsh -l
set -eu
cd -- "${0:A:h}"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.nodenv/shims"

if ! command -v npm >/dev/null || ! command -v uv >/dev/null; then
  echo 'Install Node.js 22.12 or later and uv, then open this file again.'
  exit 1
fi

if [[ ! -x node_modules/.bin/tsx ]]; then
  npm ci
fi
exec npm run pair -- --browser
