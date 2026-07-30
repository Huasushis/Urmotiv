#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "用法：scripts/deploy/validate-env.sh /绝对路径/urmotiv.env" >&2
  exit 64
fi

env_file="$1"
if [[ ! -f "$env_file" ]]; then
  echo "未找到私有环境文件。" >&2
  exit 66
fi

if [[ "$(stat -c '%a' "$env_file")" != "600" ]]; then
  echo "私有环境文件权限必须是 600。" >&2
  exit 77
fi

required=(
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB MINIO_ROOT_USER
  MINIO_ROOT_PASSWORD S3_BUCKET SESSION_SECRET URMOTIV_PLUGIN_SECRET_KEY
  URMOTIV_WEB_ORIGIN
)

for key in "${required[@]}"; do
  if ! grep -Eq "^${key}=.+$" "$env_file"; then
    echo "私有环境文件缺少 ${key}。" >&2
    exit 78
  fi
done

if ! grep -Eq '^URMOTIV_PLUGIN_SECRET_KEY=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' "$env_file"; then
  echo "URMOTIV_PLUGIN_SECRET_KEY 必须是 32 字节随机值的 Base64URL 编码。" >&2
  exit 78
fi

if ! grep -Eq '^URMOTIV_WEB_ORIGIN=https?://[^/]+/?$' "$env_file"; then
  echo "URMOTIV_WEB_ORIGIN 必须是站点的 http 或 https 地址，不能带路径。" >&2
  exit 78
fi

echo "环境文件的必填项和权限已通过检查。"
