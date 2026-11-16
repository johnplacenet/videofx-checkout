#!/bin/bash
cd "$(dirname "$0")" || exit 1
export LICENSE_API="https://videofx.thecre8iveplace.com"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  osascript -e 'display dialog "Install Google Chrome, then open Start VideoFX again." buttons {"OK"} default button "OK"'
  open "https://www.google.com/chrome/"
  exit 1
fi

if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:4177/"; then
  open "http://127.0.0.1:4177/"
  exit 0
fi

NODE_DIR="$PWD/.node"
NODE="$NODE_DIR/bin/node"
if [ ! -x "$NODE" ]; then
  echo "Setting up VideoFX. This first open can take a few minutes."
  case "$(uname -m)" in
    arm64) NODE_ARCH="arm64" ;;
    x86_64) NODE_ARCH="x64" ;;
    *)
      echo "This Mac type is not supported."
      exit 1
      ;;
  esac
  mkdir -p "$NODE_DIR"
  curl -fL "https://nodejs.org/dist/v22.23.5/node-v22.23.5-darwin-${NODE_ARCH}.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
fi

if [ ! -d "$PWD/node_modules/playwright" ]; then
  echo "Installing the app pieces."
  "$NODE_DIR/bin/npm" install --omit=dev --cache "$PWD/.npm-cache"
fi

(sleep 1; open "http://127.0.0.1:4177/") &
exec "$NODE" src/server.js
