#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "用法：scripts/deploy/backup.sh /绝对路径/urmotiv.env /绝对路径/备份目录" >&2
  exit 64
fi

env_file="$1"
backup_directory="$2"
root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "$root_directory/scripts/deploy/validate-env.sh" "$env_file"
mkdir -p "$backup_directory"
chmod 700 "$backup_directory"

backup_file="$backup_directory/postgres-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
docker compose --project-directory "$root_directory" --env-file "$env_file" \
  exec -T postgres sh -ec 'pg_dump --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  > "$backup_file"

test -s "$backup_file"
echo "数据库备份已写入指定目录。"
