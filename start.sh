#!/bin/bash
set -e

# ── Siftly Launcher ───────────────────────────────────────────────────────────
# Run this once to set up and start Siftly.
# After first run, just run it again to start the app.
# ─────────────────────────────────────────────────────────────────────────────

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${BLUE}  Siftly${NC}"
echo "  AI-powered bookmark manager"
echo ""

# ── 1. Install dependencies if needed ─────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
  echo ""
fi

# ── 2. Create .env if missing ─────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo "  Creating .env file..."
  echo 'DATABASE_URL="file:./prisma/dev.db"' > .env
  echo ""
fi

# ── 3. Set up database ────────────────────────────────────────────────────────
GENERATED_CLIENT="app/generated/prisma/client/index.js"
SCHEMA_FILE="prisma/schema.prisma"

# Only regenerate if client is missing or schema is newer
if [ ! -f "$GENERATED_CLIENT" ] || [ "$SCHEMA_FILE" -nt "$GENERATED_CLIENT" ]; then
  echo "  Generating Prisma client..."
  npx prisma generate
fi

if [ ! -f "prisma/dev.db" ]; then
  echo "  Setting up database..."
  npx prisma migrate deploy 2>/dev/null || npx prisma db push
fi
echo ""

# ── 4. Check auth ─────────────────────────────────────────────────────────────
if command -v claude &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Claude CLI detected — AI features will use your subscription automatically"
else
  echo -e "  ${YELLOW}i${NC} Claude CLI not found. Add your API key in Settings after opening the app."
fi
echo ""

# ── 5. Open browser and start ─────────────────────────────────────────────────
echo "  Starting on http://localhost:3000"
echo "  Press Ctrl+C to stop"
echo ""

# Cross-platform browser open
open_browser() {
  local url="$1"
  case "$(uname -s)" in
    Darwin)  open "$url" ;;
    Linux)   xdg-open "$url" 2>/dev/null || sensible-browser "$url" 2>/dev/null ;;
    MINGW*|MSYS*|CYGWIN*) start "$url" ;;
    *)       echo "  Open $url in your browser" ;;
  esac
}

(sleep 2 && open_browser http://localhost:3000) &

npx next dev
