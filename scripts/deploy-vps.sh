#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT_DIR/.deploy.env}"

if [[ -f "$DEPLOY_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV_FILE"
fi

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_APP_DIR="${DEPLOY_APP_DIR:-/root/ai-betting}"
DEPLOY_PM2_APP="${DEPLOY_PM2_APP:-ai-betting-bot}"
DEPLOY_SSH_PASSWORD="${DEPLOY_SSH_PASSWORD:-}"

RESET_DATA=false
SKIP_BUILD=false
SKIP_SMOKE_CHECK=false
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-vps.sh [options]

Options:
  --reset-data         Remove checkpoints, picks log, and dedup state on the VPS app
  --skip-build         Skip local typecheck/build before packaging
  --skip-smoke-check   Skip the remote API-Sports smoke check after restart
  --dry-run            Print the resolved deployment config and exit
  --help               Show this help text
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset-data)
      RESET_DATA=true
      ;;
    --skip-build)
      SKIP_BUILD=true
      ;;
    --skip-smoke-check)
      SKIP_SMOKE_CHECK=true
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required setting: $name" >&2
    if [[ -f "$DEPLOY_ENV_FILE" ]]; then
      echo "Loaded config file: $DEPLOY_ENV_FILE" >&2
    else
      echo "Create $DEPLOY_ENV_FILE from .deploy.env.example or export the variable before running." >&2
    fi
    exit 1
  fi
}

require_cmd tar
require_cmd ssh
require_cmd scp
require_cmd npm
require_var DEPLOY_HOST

SSH_CMD=(ssh -o StrictHostKeyChecking=accept-new -p "$DEPLOY_PORT")
SCP_CMD=(scp -o StrictHostKeyChecking=accept-new -P "$DEPLOY_PORT")

if [[ -n "$DEPLOY_SSH_PASSWORD" ]]; then
  require_cmd sshpass
  SSH_CMD=(sshpass -p "$DEPLOY_SSH_PASSWORD" "${SSH_CMD[@]}")
  SCP_CMD=(sshpass -p "$DEPLOY_SSH_PASSWORD" "${SCP_CMD[@]}")
fi

REMOTE_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"

if [[ "$DRY_RUN" == true ]]; then
  cat <<EOF
Deploy config
  host         : $DEPLOY_HOST
  port         : $DEPLOY_PORT
  user         : $DEPLOY_USER
  app dir      : $DEPLOY_APP_DIR
  pm2 app      : $DEPLOY_PM2_APP
  reset data   : $RESET_DATA
  skip build   : $SKIP_BUILD
  smoke check  : $([[ "$SKIP_SMOKE_CHECK" == true ]] && echo disabled || echo enabled)
  auth         : $([[ -n "$DEPLOY_SSH_PASSWORD" ]] && echo sshpass || echo ssh)
  config file  : $DEPLOY_ENV_FILE
EOF
  exit 0
fi

if [[ "$SKIP_BUILD" != true ]]; then
  echo "[deploy] running local typecheck"
  (cd "$ROOT_DIR" && npm run typecheck)
  echo "[deploy] running local build"
  (cd "$ROOT_DIR" && npm run build)
fi

commit_ref="$(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo local)"
timestamp="$(date +%Y%m%d-%H%M%S)"
archive_path="/tmp/ai-betting-${commit_ref}-${timestamp}.tgz"
remote_archive="/tmp/$(basename "$archive_path")"

cleanup() {
  rm -f "$archive_path"
}
trap cleanup EXIT

echo "[deploy] creating archive $archive_path"
(
  cd "$ROOT_DIR"
  COPYFILE_DISABLE=1 COPY_EXTENDED_ATTRIBUTES_DISABLE=1 tar -czf "$archive_path" \
    --disable-copyfile \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='logs' \
    --exclude='data' \
    --exclude='.env' \
    --exclude='.deploy.env' \
    .
)

echo "[deploy] uploading archive to $REMOTE_TARGET:$remote_archive"
"${SCP_CMD[@]}" "$archive_path" "$REMOTE_TARGET:$remote_archive"

echo "[deploy] deploying on VPS"
"${SSH_CMD[@]}" "$REMOTE_TARGET" \
  "DEPLOY_APP_DIR='$DEPLOY_APP_DIR' DEPLOY_PM2_APP='$DEPLOY_PM2_APP' REMOTE_ARCHIVE='$remote_archive' RESET_DATA='$RESET_DATA' SKIP_SMOKE_CHECK='$SKIP_SMOKE_CHECK' bash -se" <<'REMOTE'
set -euo pipefail

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_path="${DEPLOY_APP_DIR}-backup-${timestamp}"

mkdir -p "$DEPLOY_APP_DIR" "$DEPLOY_APP_DIR/data" "$DEPLOY_APP_DIR/logs"

if [[ -n "$(find "$DEPLOY_APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  cp -a "$DEPLOY_APP_DIR" "$backup_path"
else
  backup_path="(skipped: empty app dir)"
fi

pm2_exists=false
if pm2 describe "$DEPLOY_PM2_APP" >/dev/null 2>&1; then
  pm2_exists=true
  pm2 stop "$DEPLOY_PM2_APP"
fi

find "$DEPLOY_APP_DIR" -mindepth 1 -maxdepth 1 \
  ! -name .env \
  ! -name data \
  ! -name logs \
  -exec rm -rf {} +

tar -xzf "$REMOTE_ARCHIVE" -C "$DEPLOY_APP_DIR"
find "$DEPLOY_APP_DIR" -name '._*' -type f -delete

cd "$DEPLOY_APP_DIR"
npm ci --omit=dev

if [[ "$RESET_DATA" == true ]]; then
  rm -rf data/checkpoints
  rm -f data/picks-log.json data/posted.json
fi

if [[ "$pm2_exists" == true ]]; then
  pm2 restart "$DEPLOY_PM2_APP" --update-env
else
  pm2 start dist/index.js --name "$DEPLOY_PM2_APP" --cwd "$DEPLOY_APP_DIR"
fi
pm2 save >/dev/null 2>&1 || true

rm -f "$REMOTE_ARCHIVE"

if [[ "$SKIP_SMOKE_CHECK" != true ]]; then
  node - <<'JS'
require('dotenv/config');
const { fetchFixturesViaApiSports } = require('./dist/sports/providers/api-sports-fixtures');

(async () => {
  const date = new Date().toISOString().slice(0, 10);
  const fixtures = await fetchFixturesViaApiSports(date);
  const counts = fixtures.reduce((acc, fixture) => {
    acc[fixture.competition] = (acc[fixture.competition] ?? 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    smokeCheckDate: date,
    totalFixtures: fixtures.length,
    counts,
  }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
JS
fi

printf 'Backup created: %s\n' "$backup_path"
pm2 status "$DEPLOY_PM2_APP"
REMOTE

echo "[deploy] finished"