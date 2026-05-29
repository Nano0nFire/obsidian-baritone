#!/usr/bin/env bash
# 対話型サーバーセットアップ（Docker前提）。.env を生成し docker compose を起動する。
# - PostgreSQL: 同梱(bundled) / 外部(external) を選択
# - MinIO:      同梱(bundled) / 外部(external) を選択
# - ポート/公開URL/TLS/初期管理ユーザー/ゴミ箱保持日数 などを対話取得
# 非対話実行: SETUP_NONINTERACTIVE=1 + 必要な環境変数を渡す
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

# ---- helpers ---------------------------------------------------------------
c_info(){ printf '\033[36m%s\033[0m\n' "$*"; }
c_ok(){   printf '\033[32m%s\033[0m\n' "$*"; }
c_warn(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_err(){  printf '\033[31m%s\033[0m\n' "$*" 1>&2; }
die(){ c_err "ERROR: $*"; exit 1; }

NONINTERACTIVE="${SETUP_NONINTERACTIVE:-0}"

ask(){ # ask VAR "prompt" "default"
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
  if [ "$NONINTERACTIVE" = "1" ]; then
    printf -v "$__var" '%s' "${!__var:-$__default}"; return
  fi
  if [ -n "$__default" ]; then read -r -p "$__prompt [$__default]: " __ans || true
  else read -r -p "$__prompt: " __ans || true; fi
  printf -v "$__var" '%s' "${__ans:-$__default}"
}
ask_secret(){ # ask_secret VAR "prompt"
  local __var="$1" __prompt="$2" __ans=""
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "${!__var:-}"; return; fi
  read -r -s -p "$__prompt: " __ans || true; echo; printf -v "$__var" '%s' "$__ans"
}
ask_choice(){ # ask_choice VAR "prompt" "opt1" "opt2" ... (default=1)
  local __var="$1"; shift; local __prompt="$1"; shift; local opts=("$@") i ans
  if [ "$NONINTERACTIVE" = "1" ]; then printf -v "$__var" '%s' "${!__var:-${opts[0]}}"; return; fi
  echo "$__prompt"; for i in "${!opts[@]}"; do echo "  $((i+1))) ${opts[$i]}"; done
  read -r -p "選択 [1]: " ans || true; ans="${ans:-1}"
  printf -v "$__var" '%s' "${opts[$((ans-1))]:-${opts[0]}}"
}
gen_secret(){ openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | xxd -p -c256; }
gen_pw(){ openssl rand -base64 24 2>/dev/null | tr -d '/+=' | cut -c1-24; }

# ---- prerequisites ---------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker が見つかりません。Docker をインストールしてください。"
if docker compose version >/dev/null 2>&1; then DC="docker compose";
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose";
else die "docker compose が見つかりません。"; fi
c_ok "Docker OK ($DC)"

if [ -f "$ENV_FILE" ]; then
  c_warn ".env が既に存在します。"
  ask REUSE "再設定しますか? (y=再設定 / n=既存を使う)" "n"
  [ "$REUSE" = "n" ] && { c_info "既存の .env を使用します。"; SKIP_CONFIG=1; } || SKIP_CONFIG=0
else SKIP_CONFIG=0; fi

if [ "${SKIP_CONFIG:-0}" != "1" ]; then
  c_info "=== サーバー基本設定 ==="
  ask SERVER_PORT "公開ポート(HTTP/WS)" "3000"
  ask PUBLIC_URL  "クライアントが接続する公開URL" "http://localhost:${SERVER_PORT}"
  ask TRASH_RETENTION_DAYS "サーバーゴミ箱の保持日数" "30"
  ask COMPOSE_PROJECT "コンテナ名プレフィックス" "obsidian-sync"

  c_info "=== TLS ==="
  ask_choice TLS_MODE "TLSの方式を選択:" "none(リバースプロキシ前提)" "caddy(自動HTTPS)"
  CADDY_DOMAIN=""; CADDY_EMAIL=""
  if [[ "$TLS_MODE" == caddy* ]]; then
    ask CADDY_DOMAIN "公開ドメイン名" ""
    ask CADDY_EMAIL  "Let's Encrypt 用メール" ""
  fi

  c_info "=== PostgreSQL ==="
  ask_choice PG_MODE "PostgreSQL:" "同梱(コンテナで立てる)" "外部(既存を利用)"
  if [[ "$PG_MODE" == 同梱* ]]; then
    DB_MODE="bundled"
    ask PGPORT "公開ポート" "5432"
    ask POSTGRES_DB "DB名" "obsidian_sync"
    ask POSTGRES_USER "ユーザー" "obsidian"
    DEF_PW="$(gen_pw)"; ask POSTGRES_PASSWORD "パスワード(空でランダム生成)" "$DEF_PW"
    ask PG_DATA_DIR "データ保存先(ホストパス)" "./data/postgres"
    DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
  else
    DB_MODE="external"
    ask PGHOST "ホスト" ""; ask PGPORT "ポート" "5432"
    ask POSTGRES_DB "DB名" "obsidian_sync"; ask POSTGRES_USER "ユーザー" ""
    ask_secret POSTGRES_PASSWORD "パスワード"
    ask PGSSLMODE "sslmode(disable/require/verify-full)" "require"
    DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PGHOST}:${PGPORT}/${POSTGRES_DB}?sslmode=${PGSSLMODE}"
  fi

  c_info "=== オブジェクトストレージ(MinIO/S3) ==="
  ask_choice S3_MODE "オブジェクトストレージ:" "同梱MinIO" "外部S3互換"
  if [[ "$S3_MODE" == 同梱* ]]; then
    OBJ_MODE="bundled"
    ask MINIO_PORT "APIポート" "9000"; ask MINIO_CONSOLE_PORT "コンソールポート" "9001"
    ask MINIO_ROOT_USER "ルートユーザー" "minioadmin"
    DEF_MPW="$(gen_pw)"; ask MINIO_ROOT_PASSWORD "ルートパスワード(空でランダム)" "$DEF_MPW"
    ask S3_BUCKET "バケット名" "obsidian-blobs"
    ask MINIO_DATA_DIR "データ保存先(ホストパス)" "./data/minio"
    S3_ENDPOINT="http://minio:9000"; S3_ACCESS_KEY="$MINIO_ROOT_USER"; S3_SECRET_KEY="$MINIO_ROOT_PASSWORD"; S3_REGION="us-east-1"
  else
    OBJ_MODE="external"
    ask S3_ENDPOINT "S3エンドポイントURL" ""; ask S3_BUCKET "バケット名" "obsidian-blobs"
    ask S3_ACCESS_KEY "アクセスキー" ""; ask_secret S3_SECRET_KEY "シークレットキー"; ask S3_REGION "リージョン" "us-east-1"
  fi

  c_info "=== 認証 / 初期管理ユーザー ==="
  JWT_SECRET="$(gen_secret)"; c_ok "JWTシークレットを自動生成しました。"
  ask ADMIN_USER "初期管理ユーザー名" "admin"
  ADMIN_PW=""; ask_secret ADMIN_PW "初期管理パスワード(空でランダム生成)"
  [ -z "$ADMIN_PW" ] && { ADMIN_PW="$(gen_pw)"; ADMIN_PW_GENERATED=1; }

  # COMPOSE_PROFILES: 同梱サービスのみ起動対象に含める
  PROFILES=""
  [ "$DB_MODE" = "bundled" ] && PROFILES="${PROFILES:+$PROFILES,}bundled-db"
  [ "$OBJ_MODE" = "bundled" ] && PROFILES="${PROFILES:+$PROFILES,}bundled-minio"
  [[ "$TLS_MODE" == caddy* ]] && PROFILES="${PROFILES:+$PROFILES,}tls-caddy"

  c_info "=== .env を書き出します ==="
  umask 077
  cat > "$ENV_FILE" <<EOF
# 自動生成: setup.sh ($(date -u +%FT%TZ)) — 手動編集も可
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT}
COMPOSE_PROFILES=${PROFILES}

SERVER_PORT=${SERVER_PORT}
PUBLIC_URL=${PUBLIC_URL}
TRASH_RETENTION_DAYS=${TRASH_RETENTION_DAYS}
JWT_SECRET=${JWT_SECRET}

# --- Database ---
DB_MODE=${DB_MODE}
DATABASE_URL=${DATABASE_URL}
POSTGRES_DB=${POSTGRES_DB:-}
POSTGRES_USER=${POSTGRES_USER:-}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-}
PGPORT=${PGPORT:-5432}
PG_DATA_DIR=${PG_DATA_DIR:-./data/postgres}

# --- Object storage ---
OBJ_MODE=${OBJ_MODE}
S3_ENDPOINT=${S3_ENDPOINT}
S3_BUCKET=${S3_BUCKET}
S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
S3_REGION=${S3_REGION}
MINIO_PORT=${MINIO_PORT:-9000}
MINIO_CONSOLE_PORT=${MINIO_CONSOLE_PORT:-9001}
MINIO_ROOT_USER=${MINIO_ROOT_USER:-}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:-}
MINIO_DATA_DIR=${MINIO_DATA_DIR:-./data/minio}

# --- TLS (caddy profile) ---
TLS_MODE=${TLS_MODE%%(*}
CADDY_DOMAIN=${CADDY_DOMAIN:-}
CADDY_EMAIL=${CADDY_EMAIL:-}
EOF
  c_ok ".env を書き出しました: $ENV_FILE"
fi

# ---- external connectivity validation -------------------------------------
set -a; . "$ENV_FILE"; set +a
if [ "${DB_MODE:-}" = "external" ]; then
  c_info "外部PostgreSQLへの接続を検証します..."
  if docker run --rm postgres:16-alpine pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
    c_ok "PostgreSQL 接続OK"
  else
    c_warn "接続検証に失敗しました（情報を確認してください）。"
    ask CONT "続行しますか? (y/n)" "n"; [ "$CONT" = "y" ] || die "中断しました。"
  fi
fi

# ---- bring up --------------------------------------------------------------
ask DOUP "今すぐ起動しますか? ($DC up -d) (y/n)" "y"
if [ "$DOUP" = "y" ]; then
  ( cd "$SCRIPT_DIR" && $DC up -d )
  c_info "DBマイグレーションを実行..."
  ( cd "$SCRIPT_DIR" && $DC run --rm server npm run migrate ) || c_warn "migrate に失敗（サーバーイメージ未ビルドの可能性）"
  c_info "初期管理ユーザーを作成..."
  ( cd "$SCRIPT_DIR" && ADMIN_USER="$ADMIN_USER" ADMIN_PW="$ADMIN_PW" \
      $DC run --rm server node dist/cli.js create-user --username "$ADMIN_USER" --password "$ADMIN_PW" ) \
      || c_warn "ユーザー作成はサーバー起動後に手動でも可能"
  echo
  c_ok "=== セットアップ完了 ==="
  echo "  公開URL : ${PUBLIC_URL}"
  echo "  管理ユーザー: ${ADMIN_USER}"
  [ "${ADMIN_PW_GENERATED:-0}" = "1" ] && c_warn "  生成パスワード: ${ADMIN_PW}  (今すぐ控えてください)"
  echo "  プラグインに上記URLと認証情報を入力してください。"
else
  c_info "後で起動: (cd $SCRIPT_DIR && $DC up -d)"
fi
