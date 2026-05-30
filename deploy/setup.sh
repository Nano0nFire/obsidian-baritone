#!/usr/bin/env bash
# Interactive Docker setup for the self-hosted Obsidian Sync server.
# Non-interactive: SETUP_NONINTERACTIVE=1 plus env vars; set SETUP_FORCE=1 to overwrite .env.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SETUP_ENV_FILE:-${SCRIPT_DIR}/.env}"
NONINTERACTIVE="${SETUP_NONINTERACTIVE:-0}"

c_info(){ printf '\033[36m%s\033[0m\n' "$*"; }
c_ok(){ printf '\033[32m%s\033[0m\n' "$*"; }
c_warn(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_err(){ printf '\033[31m%s\033[0m\n' "$*" 1>&2; }
die(){ c_err "ERROR: $*"; exit 1; }

ask(){
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "${!__var:-$__default}"; return; fi
  if [ -n "$__default" ]; then read -r -p "$__prompt [$__default]: " __ans || true; else read -r -p "$__prompt: " __ans || true; fi
  printf -v "$__var" '%s' "${__ans:-$__default}"
}

ask_secret(){
  local __var="$1" __prompt="$2" __ans=""
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "${!__var:-}"; return; fi
  read -r -s -p "$__prompt: " __ans || true; echo; printf -v "$__var" '%s' "$__ans"
}

ask_choice(){
  local __var="$1"; shift; local __prompt="$1"; shift; local opts=("$@") i ans
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "${!__var:-${opts[0]}}"; return; fi
  echo "$__prompt"; for i in "${!opts[@]}"; do echo "  $((i+1))) ${opts[$i]}"; done
  read -r -p "Select [1]: " ans || true; ans="${ans:-1}"
  printf -v "$__var" '%s' "${opts[$((ans-1))]:-${opts[0]}}"
}

gen_secret(){ openssl rand -hex 32; }
gen_pw(){ openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }
compose(){ ( cd "$SCRIPT_DIR" && $DC "$@" ); }

command -v docker >/dev/null 2>&1 || die "docker is required."
command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else die "docker compose is required."; fi
c_ok "Prerequisites OK ($DC, openssl)"

SKIP_CONFIG=0
if [ -f "$ENV_FILE" ] && [ "${SETUP_FORCE:-0}" != "1" ]; then
  c_warn "deploy/.env already exists."
  if [ "$NONINTERACTIVE" = "1" ]; then
    SKIP_CONFIG=1
  else
    ask REUSE "Reuse existing .env? (y=reuse / n=reconfigure)" "y"
    [ "$REUSE" = "y" ] && SKIP_CONFIG=1
  fi
fi

if [ "$SKIP_CONFIG" != "1" ]; then
  c_info "=== Server ==="
  ask SERVER_PORT "Public HTTP/WebSocket port" "3000"
  ask PUBLIC_URL "Public URL used by clients" "http://localhost:${SERVER_PORT}"
  ask TRASH_RETENTION_DAYS "Server trash retention days" "30"
  ask LOG_LEVEL "Log level (debug/info/warn/error)" "info"
  ask SHUTDOWN_TIMEOUT_MS "Graceful shutdown timeout ms" "15000"
  ask COMPOSE_PROJECT_NAME "Compose project/container prefix" "obsidian-sync"

  c_info "=== Rate limiting ==="
  ask AUTH_RATE_LIMIT_MAX_FAILURES "Auth failures before lockout" "5"
  ask AUTH_RATE_LIMIT_WINDOW_MS "Auth failure window ms" "60000"
  ask AUTH_RATE_LIMIT_LOCKOUT_MS "Auth lockout ms" "300000"
  ask WS_CONNECTION_RATE_LIMIT_MAX "WebSocket connections per IP per window" "30"
  ask WS_CONNECTION_RATE_LIMIT_WINDOW_MS "WebSocket connection window ms" "60000"
  ask WS_MESSAGE_RATE_LIMIT_MAX "WebSocket messages per connection per window" "120"
  ask WS_MESSAGE_RATE_LIMIT_WINDOW_MS "WebSocket message window ms" "10000"
  ask YJS_UPDATE_RATE_LIMIT_MAX "Yjs updates per room participant per window" "120"
  ask YJS_UPDATE_RATE_LIMIT_WINDOW_MS "Yjs update window ms" "10000"

  c_info "=== TLS ==="
  ask_choice TLS_MODE "TLS mode:" "none" "caddy"
  CADDY_DOMAIN="${CADDY_DOMAIN:-}"; CADDY_EMAIL="${CADDY_EMAIL:-}"
  if [ "$TLS_MODE" = "caddy" ]; then
    ask CADDY_DOMAIN "Public domain name" "$CADDY_DOMAIN"
    ask CADDY_EMAIL "Let's Encrypt email" "$CADDY_EMAIL"
    [ -n "$CADDY_DOMAIN" ] || die "CADDY_DOMAIN is required for TLS mode caddy."
  fi

  c_info "=== PostgreSQL ==="
  ask_choice DB_MODE "PostgreSQL mode:" "bundled" "external"
  if [ "$DB_MODE" = "bundled" ]; then
    ask PGPORT "Host PostgreSQL port" "5432"
    ask POSTGRES_DB "Database name" "obsidian_sync"
    ask POSTGRES_USER "Database user" "obsidian"
    DEF_PW="$(gen_pw)"; ask POSTGRES_PASSWORD "Database password" "$DEF_PW"
    ask PG_DATA_DIR "PostgreSQL data directory" "./data/postgres"
    PGHOST="postgres"; PGSSLMODE="disable"
    DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
  else
    ask PGHOST "PostgreSQL host" "${PGHOST:-}"
    ask PGPORT "PostgreSQL port" "${PGPORT:-5432}"
    ask POSTGRES_DB "Database name" "${POSTGRES_DB:-obsidian_sync}"
    ask POSTGRES_USER "Database user" "${POSTGRES_USER:-}"
    ask_secret POSTGRES_PASSWORD "Database password"
    ask PGSSLMODE "sslmode (disable/require/verify-full)" "${PGSSLMODE:-require}"
    [ -n "$PGHOST" ] && [ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_PASSWORD" ] || die "External PostgreSQL host/user/password are required."
    PG_DATA_DIR="./data/postgres"
    DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PGHOST}:${PGPORT}/${POSTGRES_DB}?sslmode=${PGSSLMODE}"
  fi

  c_info "=== Object storage ==="
  ask_choice OBJ_MODE "Object storage mode:" "bundled" "external"
  if [ "$OBJ_MODE" = "bundled" ]; then
    ask MINIO_PORT "Host MinIO API port" "9000"
    ask MINIO_CONSOLE_PORT "Host MinIO console port" "9001"
    ask MINIO_ROOT_USER "MinIO root user" "minioadmin"
    DEF_MPW="$(gen_pw)"; ask MINIO_ROOT_PASSWORD "MinIO root password" "$DEF_MPW"
    ask S3_BUCKET "S3 bucket" "obsidian-blobs"
    ask MINIO_DATA_DIR "MinIO data directory" "./data/minio"
    S3_ENDPOINT="http://minio:9000"; S3_ACCESS_KEY="$MINIO_ROOT_USER"; S3_SECRET_KEY="$MINIO_ROOT_PASSWORD"; S3_REGION="us-east-1"
  else
    ask S3_ENDPOINT "S3 endpoint URL" "${S3_ENDPOINT:-}"
    ask S3_BUCKET "S3 bucket" "${S3_BUCKET:-obsidian-blobs}"
    ask S3_ACCESS_KEY "S3 access key" "${S3_ACCESS_KEY:-}"
    ask_secret S3_SECRET_KEY "S3 secret key"
    ask S3_REGION "S3 region" "${S3_REGION:-us-east-1}"
    [ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] && [ -n "$S3_ACCESS_KEY" ] && [ -n "$S3_SECRET_KEY" ] || die "External S3 endpoint/bucket/key/secret are required."
    MINIO_PORT="9000"; MINIO_CONSOLE_PORT="9001"; MINIO_ROOT_USER=""; MINIO_ROOT_PASSWORD=""; MINIO_DATA_DIR="./data/minio"
  fi

  c_info "=== Auth bootstrap ==="
  JWT_SECRET="${JWT_SECRET:-$(gen_secret)}"
  ask ADMIN_USER "Initial admin username" "${ADMIN_USER:-admin}"
  ADMIN_PW="${ADMIN_PW:-}"; ask_secret ADMIN_PW "Initial admin password (blank to generate)"
  ADMIN_PW_GENERATED=0
  if [ -z "$ADMIN_PW" ]; then ADMIN_PW="$(gen_pw)"; ADMIN_PW_GENERATED=1; fi

  COMPOSE_PROFILES=""
  [ "$DB_MODE" = "bundled" ] && COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}bundled-db"
  [ "$OBJ_MODE" = "bundled" ] && COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}bundled-minio"
  [ "$TLS_MODE" = "caddy" ] && COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}tls-caddy"

  umask 077
  cat > "$ENV_FILE" <<ENVEOF
# Generated by deploy/setup.sh on $(date -u +%FT%TZ)
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
COMPOSE_PROFILES=${COMPOSE_PROFILES}

SERVER_PORT=${SERVER_PORT}
PUBLIC_URL=${PUBLIC_URL}
TRASH_RETENTION_DAYS=${TRASH_RETENTION_DAYS}
LOG_LEVEL=${LOG_LEVEL}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS}
JWT_SECRET=${JWT_SECRET}

AUTH_RATE_LIMIT_MAX_FAILURES=${AUTH_RATE_LIMIT_MAX_FAILURES}
AUTH_RATE_LIMIT_WINDOW_MS=${AUTH_RATE_LIMIT_WINDOW_MS}
AUTH_RATE_LIMIT_LOCKOUT_MS=${AUTH_RATE_LIMIT_LOCKOUT_MS}
WS_CONNECTION_RATE_LIMIT_MAX=${WS_CONNECTION_RATE_LIMIT_MAX}
WS_CONNECTION_RATE_LIMIT_WINDOW_MS=${WS_CONNECTION_RATE_LIMIT_WINDOW_MS}
WS_MESSAGE_RATE_LIMIT_MAX=${WS_MESSAGE_RATE_LIMIT_MAX}
WS_MESSAGE_RATE_LIMIT_WINDOW_MS=${WS_MESSAGE_RATE_LIMIT_WINDOW_MS}
YJS_UPDATE_RATE_LIMIT_MAX=${YJS_UPDATE_RATE_LIMIT_MAX}
YJS_UPDATE_RATE_LIMIT_WINDOW_MS=${YJS_UPDATE_RATE_LIMIT_WINDOW_MS}

DB_MODE=${DB_MODE}
DATABASE_URL=${DATABASE_URL}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
PGHOST=${PGHOST}
PGPORT=${PGPORT}
PGSSLMODE=${PGSSLMODE}
PG_DATA_DIR=${PG_DATA_DIR}

OBJ_MODE=${OBJ_MODE}
S3_ENDPOINT=${S3_ENDPOINT}
S3_BUCKET=${S3_BUCKET}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_REGION=${S3_REGION}
MINIO_PORT=${MINIO_PORT}
MINIO_CONSOLE_PORT=${MINIO_CONSOLE_PORT}
MINIO_ROOT_USER=${MINIO_ROOT_USER}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
MINIO_DATA_DIR=${MINIO_DATA_DIR}

TLS_MODE=${TLS_MODE}
CADDY_DOMAIN=${CADDY_DOMAIN}
CADDY_EMAIL=${CADDY_EMAIL}
ENVEOF
  c_ok "Wrote $ENV_FILE"
else
  ADMIN_USER="${ADMIN_USER:-admin}"
  ADMIN_PW="${ADMIN_PW:-}"
  ADMIN_PW_GENERATED=0
fi

set -a; . "$ENV_FILE"; set +a

if [ "${DB_MODE:-}" = "external" ]; then
  c_info "Validating external PostgreSQL with pg_isready in a throwaway container..."
  if docker run --rm postgres:16-alpine pg_isready "$DATABASE_URL" >/dev/null 2>&1; then
    c_ok "External PostgreSQL is reachable."
  else
    if [ "$NONINTERACTIVE" = "1" ]; then die "External PostgreSQL validation failed."; fi
    c_warn "External PostgreSQL validation failed."
    ask CONTINUE_AFTER_PG_FAIL "Continue anyway? (y/n)" "n"
    [ "$CONTINUE_AFTER_PG_FAIL" = "y" ] || die "Aborted."
  fi
fi

DOUP_DEFAULT="y"
[ "$NONINTERACTIVE" = "1" ] && DOUP_DEFAULT="n"
ask DOUP "Build, migrate, bootstrap admin, and start now? (y/n)" "$DOUP_DEFAULT"
if [ "$DOUP" = "y" ]; then
  c_info "Building server image from repository root: $REPO_ROOT"
  compose build server

  if [ "${DB_MODE:-}" = "bundled" ]; then compose up -d postgres; fi
  if [ "${OBJ_MODE:-}" = "bundled" ]; then compose up -d minio; compose up minio-init; fi

  c_info "Running database migrations..."
  compose run --rm migrate

  if [ -n "${ADMIN_PW:-}" ]; then
    c_info "Creating initial admin user (idempotent if the CLI handles existing users)..."
    compose run --rm server obsidian-sync-server create-user --username "$ADMIN_USER" --password "$ADMIN_PW" || c_warn "create-user failed; retry manually after checking server CLI arguments."
  else
    c_warn "ADMIN_PW not set; skipping admin user creation."
  fi

  c_info "Starting services..."
  compose up -d
  c_ok "Setup complete. Public URL: ${PUBLIC_URL}"
  echo "Admin user: ${ADMIN_USER}"
  [ "${ADMIN_PW_GENERATED:-0}" = "1" ] && c_warn "Generated admin password: ${ADMIN_PW}"
else
  c_info "Later: cd ${SCRIPT_DIR} && docker compose build server && docker compose run --rm migrate && docker compose up -d"
fi
