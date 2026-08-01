#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator="$script_directory/validate-env.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

write_environment() {
  local target="$1"
  local plugin_secret_key="$2"
  cat >"$target" <<EOF
POSTGRES_USER=urmotiv
POSTGRES_PASSWORD=private-test-value
POSTGRES_DB=urmotiv
MINIO_ROOT_USER=urmotiv
MINIO_ROOT_PASSWORD=private-test-value
S3_BUCKET=urmotiv
SESSION_SECRET=private-test-value
URMOTIV_PLUGIN_SECRET_KEY=$plugin_secret_key
URMOTIV_WEB_ORIGIN=https://problems.example.test
EOF
  chmod 600 "$target"
}

valid_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
valid_file="$temporary_directory/valid.env"
write_environment "$valid_file" "$valid_key"
bash "$validator" "$valid_file" >"$temporary_directory/valid.out" 2>"$temporary_directory/valid.err"
grep -Fqx "环境文件的必填项和权限已通过检查。" "$temporary_directory/valid.out"
test ! -s "$temporary_directory/valid.err"

invalid_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"
invalid_file="$temporary_directory/invalid-key.env"
write_environment "$invalid_file" "$invalid_key"
if bash "$validator" "$invalid_file" >"$temporary_directory/invalid.out" 2>"$temporary_directory/invalid.err"; then
  echo "非标准 Base64URL 密钥不应通过检查。" >&2
  exit 1
fi
grep -Fqx "URMOTIV_PLUGIN_SECRET_KEY 必须是 32 字节随机值的 Base64URL 编码。" "$temporary_directory/invalid.err"
if grep -Fq "$invalid_key" "$temporary_directory/invalid.out" "$temporary_directory/invalid.err"; then
  echo "环境检查输出了密钥值。" >&2
  exit 1
fi

unsafe_file="$temporary_directory/unsafe-permissions.env"
write_environment "$unsafe_file" "$valid_key"
chmod 644 "$unsafe_file"
if bash "$validator" "$unsafe_file" >"$temporary_directory/unsafe.out" 2>"$temporary_directory/unsafe.err"; then
  echo "权限过宽的环境文件不应通过检查。" >&2
  exit 1
fi
grep -Fqx "私有环境文件权限必须是 600。" "$temporary_directory/unsafe.err"

echo "部署环境检查脚本测试通过。"
