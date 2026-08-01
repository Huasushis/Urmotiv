#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "用法：scripts/deploy/upgrade.sh /绝对路径/urmotiv.env /绝对路径/备份目录" >&2
  exit 64
fi

env_file="$1"
backup_directory="$2"
root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "$root_directory/scripts/deploy/validate-env.sh" "$env_file"
docker compose --project-directory "$root_directory" --env-file "$env_file" build
docker compose --project-directory "$root_directory" --env-file "$env_file" stop api worker web
bash "$root_directory/scripts/deploy/backup.sh" "$env_file" "$backup_directory"
docker compose --project-directory "$root_directory" --env-file "$env_file" run --rm migrate
docker compose --project-directory "$root_directory" --env-file "$env_file" up -d --remove-orphans

for attempt in $(seq 1 30); do
  if docker compose --project-directory "$root_directory" --env-file "$env_file" \
    exec -T web wget -qO- http://127.0.0.1/api/v1/health | grep -q '"status":"ok"'; then
    echo "升级完成，健康检查通过。"
    exit 0
  fi
  sleep 2
done

echo "升级后健康检查未通过；服务已保留，使用 docker compose logs 检查摘要错误。" >&2
exit 1
