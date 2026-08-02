#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validator="$script_directory/validate-env.sh"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

write_environment() {
  local target="$1"
  local plugin_secret_key="$2"
  local cas_enabled="${3:-false}"
  cat >"$target" <<EOF
POSTGRES_USER=urmotiv
POSTGRES_PASSWORD=private-test-value
POSTGRES_DB=urmotiv
MINIO_ROOT_USER=urmotiv
MINIO_ROOT_PASSWORD=private-test-value
S3_BUCKET=urmotiv
URMOTIV_PLUGIN_SECRET_KEY=$plugin_secret_key
URMOTIV_WEB_ORIGIN=https://problems.example.test
URMOTIV_CAS_ENABLED=$cas_enabled
EOF
  if [[ "$cas_enabled" == "true" ]]; then
    cat >>"$target" <<EOF
URMOTIV_CAS_LOGIN_URL=https://identity.example.test/cas/login
URMOTIV_CAS_VALIDATE_URL=https://identity.example.test/cas/serviceValidate
URMOTIV_CAS_CALLBACK_URL=https://problems.example.test/api/v1/auth/cas/callback
URMOTIV_CAS_SUBJECT_ATTRIBUTE=cas:user
URMOTIV_CAS_EMAIL_ATTRIBUTE=
URMOTIV_CAS_NICKNAME_ATTRIBUTE=
URMOTIV_CAS_STUDENT_ID_ATTRIBUTES=
URMOTIV_CAS_STATE_SECRET=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE
EOF
  fi
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

valid_cas_file="$temporary_directory/valid-cas.env"
write_environment "$valid_cas_file" "$valid_key" true
bash "$validator" "$valid_cas_file" >"$temporary_directory/valid-cas.out" 2>"$temporary_directory/valid-cas.err"
grep -Fqx "环境文件的必填项和权限已通过检查。" "$temporary_directory/valid-cas.out"
test ! -s "$temporary_directory/valid-cas.err"

assert_invalid_cas() {
  local target="$1"
  local forbidden_value="$2"
  local name="$3"
  if bash "$validator" "$target" >"$temporary_directory/${name}.out" 2>"$temporary_directory/${name}.err"; then
    echo "无效 CAS 配置不应通过检查。" >&2
    exit 1
  fi
  grep -Fqx "URMOTIV_CAS_CONFIGURATION_INVALID" "$temporary_directory/${name}.err"
  if grep -Fq "$forbidden_value" "$temporary_directory/${name}.out" "$temporary_directory/${name}.err"; then
    echo "环境检查输出了 CAS 配置值。" >&2
    exit 1
  fi
}

invalid_cas_flag="$temporary_directory/invalid-cas-flag.env"
write_environment "$invalid_cas_flag" "$valid_key"
sed -i 's/^URMOTIV_CAS_ENABLED=false$/URMOTIV_CAS_ENABLED=enabled-sentinel/' "$invalid_cas_flag"
assert_invalid_cas "$invalid_cas_flag" "enabled-sentinel" "invalid-cas-flag"

missing_cas_url="$temporary_directory/missing-cas-url.env"
cp "$valid_cas_file" "$missing_cas_url"
sed -i '/^URMOTIV_CAS_VALIDATE_URL=/d' "$missing_cas_url"
assert_invalid_cas "$missing_cas_url" "identity.example.test" "missing-cas-url"

http_cas_url="$temporary_directory/http-cas-url.env"
cp "$valid_cas_file" "$http_cas_url"
sed -i 's#^URMOTIV_CAS_LOGIN_URL=.*#URMOTIV_CAS_LOGIN_URL=http://unsafe-url-sentinel.example.test/login#' "$http_cas_url"
assert_invalid_cas "$http_cas_url" "unsafe-url-sentinel" "http-cas-url"

foreign_callback="$temporary_directory/foreign-callback.env"
cp "$valid_cas_file" "$foreign_callback"
sed -i 's#^URMOTIV_CAS_CALLBACK_URL=.*#URMOTIV_CAS_CALLBACK_URL=https://other-site-sentinel.example.test/api/v1/auth/cas/callback#' "$foreign_callback"
assert_invalid_cas "$foreign_callback" "other-site-sentinel" "foreign-callback"

wrong_callback_path="$temporary_directory/wrong-callback-path.env"
cp "$valid_cas_file" "$wrong_callback_path"
sed -i 's#^URMOTIV_CAS_CALLBACK_URL=.*#URMOTIV_CAS_CALLBACK_URL=https://problems.example.test/api/v1/auth/cas/other-sentinel#' "$wrong_callback_path"
assert_invalid_cas "$wrong_callback_path" "other-sentinel" "wrong-callback-path"

callback_query="$temporary_directory/callback-query.env"
cp "$valid_cas_file" "$callback_query"
sed -i 's#^URMOTIV_CAS_CALLBACK_URL=.*#URMOTIV_CAS_CALLBACK_URL=https://problems.example.test/api/v1/auth/cas/callback?query-sentinel=value#' "$callback_query"
assert_invalid_cas "$callback_query" "query-sentinel" "callback-query"

http_web_origin="$temporary_directory/http-web-origin.env"
cp "$valid_cas_file" "$http_web_origin"
sed -i 's#^URMOTIV_WEB_ORIGIN=.*#URMOTIV_WEB_ORIGIN=http://web-origin-sentinel.example.test#' "$http_web_origin"
sed -i 's#^URMOTIV_CAS_CALLBACK_URL=.*#URMOTIV_CAS_CALLBACK_URL=http://web-origin-sentinel.example.test/api/v1/auth/cas/callback#' "$http_web_origin"
assert_invalid_cas "$http_web_origin" "web-origin-sentinel" "http-web-origin"

weak_cas_secret="$temporary_directory/weak-cas-secret.env"
cp "$valid_cas_file" "$weak_cas_secret"
sed -i 's/^URMOTIV_CAS_STATE_SECRET=.*/URMOTIV_CAS_STATE_SECRET=weak-secret-sentinel/' "$weak_cas_secret"
assert_invalid_cas "$weak_cas_secret" "weak-secret-sentinel" "weak-cas-secret"

reused_cas_secret="$temporary_directory/reused-cas-secret.env"
cp "$valid_cas_file" "$reused_cas_secret"
sed -i "s/^URMOTIV_CAS_STATE_SECRET=.*/URMOTIV_CAS_STATE_SECRET=$valid_key/" "$reused_cas_secret"
assert_invalid_cas "$reused_cas_secret" "$valid_key" "reused-cas-secret"

short_cas_secret="$temporary_directory/short-cas-secret.env"
cp "$valid_cas_file" "$short_cas_secret"
sed -i 's/^URMOTIV_CAS_STATE_SECRET=.*/URMOTIV_CAS_STATE_SECRET=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/' "$short_cas_secret"
assert_invalid_cas "$short_cas_secret" "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" "short-cas-secret"

long_cas_secret="$temporary_directory/long-cas-secret.env"
cp "$valid_cas_file" "$long_cas_secret"
sed -i 's/^URMOTIV_CAS_STATE_SECRET=.*/URMOTIV_CAS_STATE_SECRET=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/' "$long_cas_secret"
assert_invalid_cas "$long_cas_secret" "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" "long-cas-secret"

cas_without_optional_fields="$temporary_directory/cas-without-optional-fields.env"
cp "$valid_cas_file" "$cas_without_optional_fields"
sed -i '/^URMOTIV_CAS_EMAIL_ATTRIBUTE=/d;/^URMOTIV_CAS_NICKNAME_ATTRIBUTE=/d;/^URMOTIV_CAS_STUDENT_ID_ATTRIBUTES=/d' "$cas_without_optional_fields"
bash "$validator" "$cas_without_optional_fields" >"$temporary_directory/cas-without-optional.out" 2>"$temporary_directory/cas-without-optional.err"
grep -Fqx "环境文件的必填项和权限已通过检查。" "$temporary_directory/cas-without-optional.out"
test ! -s "$temporary_directory/cas-without-optional.err"

duplicate_cas_key="$temporary_directory/duplicate-cas-key.env"
cp "$valid_cas_file" "$duplicate_cas_key"
cat >>"$duplicate_cas_key" <<EOF
URMOTIV_CAS_LOGIN_URL=https://duplicate-key-sentinel.example.test/login
EOF
assert_invalid_cas "$duplicate_cas_key" "duplicate-key-sentinel" "duplicate-cas-key"

# 关闭 CAS 时字段不必存在，也不会解析遗留的无效字段。
disabled_cas_file="$temporary_directory/disabled-cas.env"
write_environment "$disabled_cas_file" "$valid_key"
cat >>"$disabled_cas_file" <<EOF
URMOTIV_CAS_LOGIN_URL=http://ignored-disabled-sentinel.example.test/login
URMOTIV_CAS_STATE_SECRET=ignored-disabled-sentinel
EOF
bash "$validator" "$disabled_cas_file" >"$temporary_directory/disabled-cas.out" 2>"$temporary_directory/disabled-cas.err"
grep -Fqx "环境文件的必填项和权限已通过检查。" "$temporary_directory/disabled-cas.out"
test ! -s "$temporary_directory/disabled-cas.err"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && \
  command -v node >/dev/null 2>&1; then
  repository_directory="$(cd "$script_directory/../.." && pwd)"
  (
    cd "$repository_directory"
    docker compose --env-file "$valid_cas_file" config --no-env-resolution --format json
  ) | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const services = JSON.parse(input).services ?? {};
      const casKeys = [
        "URMOTIV_CAS_ENABLED",
        "URMOTIV_CAS_LOGIN_URL",
        "URMOTIV_CAS_VALIDATE_URL",
        "URMOTIV_CAS_CALLBACK_URL",
        "URMOTIV_CAS_SUBJECT_ATTRIBUTE",
        "URMOTIV_CAS_EMAIL_ATTRIBUTE",
        "URMOTIV_CAS_NICKNAME_ATTRIBUTE",
        "URMOTIV_CAS_STUDENT_ID_ATTRIBUTES",
        "URMOTIV_CAS_STATE_SECRET"
      ];
      const apiEnvironment = services.api?.environment ?? {};
      if (casKeys.some((key) => !(key in apiEnvironment))) {
        throw new Error("COMPOSE_API_CAS_SCOPE_INCOMPLETE");
      }
      for (const [serviceName, service] of Object.entries(services)) {
        if (serviceName === "api") continue;
        const environment = service.environment ?? {};
        if (Object.keys(environment).some((key) => key.startsWith("URMOTIV_CAS_"))) {
          throw new Error("COMPOSE_CAS_SCOPE_LEAK");
        }
        if (
          ["migrate", "worker", "web", "fermata"].includes(serviceName) &&
          environment.URMOTIV_PLUGIN_SECRET_KEY !== undefined
        ) {
          throw new Error("COMPOSE_API_SECRET_SCOPE_LEAK");
        }
        if (
          ["worker", "web", "fermata"].includes(serviceName) &&
          ["DATABASE_URL", "S3_ACCESS_KEY", "S3_SECRET_KEY"]
            .some((key) => environment[key] !== undefined)
        ) {
          throw new Error("COMPOSE_DATA_SECRET_SCOPE_LEAK");
        }
      }
    });
  '
else
  echo "未找到 Docker Compose 或 Node.js；未运行 Compose 环境范围合成检查。" >&2
fi

echo "部署环境检查脚本测试通过。"
