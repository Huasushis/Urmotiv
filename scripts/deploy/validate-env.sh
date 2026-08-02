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
  MINIO_ROOT_PASSWORD S3_BUCKET URMOTIV_PLUGIN_SECRET_KEY
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

cas_configuration_error() {
  echo "URMOTIV_CAS_CONFIGURATION_INVALID" >&2
  exit 78
}

cas_enabled_count="$(grep -Ec '^URMOTIV_CAS_ENABLED=' "$env_file" || true)"
if [[ "$cas_enabled_count" -gt 1 ]]; then
  cas_configuration_error
fi

cas_enabled="false"
if [[ "$cas_enabled_count" -eq 1 ]]; then
  cas_enabled="$(sed -n 's/^URMOTIV_CAS_ENABLED=//p' "$env_file")"
fi
if [[ "$cas_enabled" != "true" && "$cas_enabled" != "false" ]]; then
  cas_configuration_error
fi

if [[ "$cas_enabled" == "true" ]]; then
  cas_keys=(
    URMOTIV_CAS_LOGIN_URL URMOTIV_CAS_VALIDATE_URL URMOTIV_CAS_CALLBACK_URL
    URMOTIV_CAS_SUBJECT_ATTRIBUTE URMOTIV_CAS_EMAIL_ATTRIBUTE
    URMOTIV_CAS_NICKNAME_ATTRIBUTE URMOTIV_CAS_STUDENT_ID_ATTRIBUTES
    URMOTIV_CAS_STATE_SECRET
  )
  for key in "${cas_keys[@]}"; do
    if [[ "$(grep -Ec "^${key}=" "$env_file" || true)" -gt 1 ]]; then
      cas_configuration_error
    fi
  done

  for key in \
    URMOTIV_CAS_LOGIN_URL \
    URMOTIV_CAS_VALIDATE_URL \
    URMOTIV_CAS_CALLBACK_URL; do
    if ! grep -Eq "^${key}=https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[^[:space:]#]*)?$" "$env_file"; then
      cas_configuration_error
    fi
  done

  if ! grep -Eq '^URMOTIV_CAS_SUBJECT_ATTRIBUTE=[A-Za-z0-9_.:-]{1,160}$' "$env_file"; then
    cas_configuration_error
  fi
  for key in URMOTIV_CAS_EMAIL_ATTRIBUTE URMOTIV_CAS_NICKNAME_ATTRIBUTE; do
    if grep -Eq "^${key}=" "$env_file" && \
      ! grep -Eq "^${key}=([A-Za-z0-9_.:-]{1,160})?$" "$env_file"; then
      cas_configuration_error
    fi
  done
  if grep -Eq '^URMOTIV_CAS_STUDENT_ID_ATTRIBUTES=' "$env_file" && \
    ! grep -Eq '^URMOTIV_CAS_STUDENT_ID_ATTRIBUTES=([A-Za-z0-9_.:-]{1,160}(,[A-Za-z0-9_.:-]{1,160}){0,9})?$' "$env_file"; then
    cas_configuration_error
  fi
  if ! grep -Eq '^URMOTIV_CAS_STATE_SECRET=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' "$env_file"; then
    cas_configuration_error
  fi

  cas_state_secret="$(sed -n 's/^URMOTIV_CAS_STATE_SECRET=//p' "$env_file")"
  plugin_secret="$(sed -n 's/^URMOTIV_PLUGIN_SECRET_KEY=//p' "$env_file")"
  if [[ "$cas_state_secret" == "$plugin_secret" ]]; then
    cas_configuration_error
  fi

  web_origin="$(sed -n 's/^URMOTIV_WEB_ORIGIN=//p' "$env_file")"
  callback_url="$(sed -n 's/^URMOTIV_CAS_CALLBACK_URL=//p' "$env_file")"
  if [[ "$web_origin" != https://* ]]; then
    cas_configuration_error
  fi
  web_origin="${web_origin%/}"
  if [[ "$callback_url" != "${web_origin}/api/v1/auth/cas/callback" ]]; then
    cas_configuration_error
  fi
fi

echo "环境文件的必填项和权限已通过检查。"
