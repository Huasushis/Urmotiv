#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

fixture_root="$temporary_directory/repo"
fixture_bin="$temporary_directory/bin"
log_file="$temporary_directory/commands.log"
mkdir -p "$fixture_root/scripts/deploy" "$fixture_bin"
cp "$script_directory/upgrade.sh" "$fixture_root/scripts/deploy/upgrade.sh"

cat >"$fixture_root/scripts/deploy/validate-env.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' validate >>"$UPGRADE_TEST_LOG"
EOF

cat >"$fixture_root/scripts/deploy/backup.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' backup >>"$UPGRADE_TEST_LOG"
EOF

cat >"$fixture_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
arguments=" $* "
case "$arguments" in
  *" build "*) printf '%s\n' build >>"$UPGRADE_TEST_LOG" ;;
  *" stop api worker web "*) printf '%s\n' stop >>"$UPGRADE_TEST_LOG" ;;
  *" run --rm migrate "*)
    printf '%s\n' migrate >>"$UPGRADE_TEST_LOG"
    if [[ "${UPGRADE_TEST_FAIL_MIGRATE:-false}" == "true" ]]; then
      exit 42
    fi
    ;;
  *" up -d --remove-orphans "*) printf '%s\n' start >>"$UPGRADE_TEST_LOG" ;;
  *" exec -T web wget "*)
    printf '%s\n' health >>"$UPGRADE_TEST_LOG"
    printf '%s\n' '{"status":"ok"}'
    ;;
  *)
    printf '未识别的 docker 调用：%s\n' "$*" >&2
    exit 64
    ;;
esac
EOF

chmod 644 \
  "$fixture_root/scripts/deploy/upgrade.sh" \
  "$fixture_root/scripts/deploy/validate-env.sh" \
  "$fixture_root/scripts/deploy/backup.sh"
chmod 700 "$fixture_bin/docker"

assert_log() {
  local expected="$1"
  if [[ "$(paste -sd, "$log_file")" != "$expected" ]]; then
    echo "升级脚本调用顺序不符合预期。" >&2
    exit 1
  fi
}

export PATH="$fixture_bin:$PATH"
export UPGRADE_TEST_LOG="$log_file"

bash "$fixture_root/scripts/deploy/upgrade.sh" \
  "$temporary_directory/test.env" "$temporary_directory/backups" \
  >"$temporary_directory/success.out" 2>"$temporary_directory/success.err"
assert_log "validate,build,stop,backup,migrate,start,health"
grep -Fqx "升级完成，健康检查通过。" "$temporary_directory/success.out"
test ! -s "$temporary_directory/success.err"

: >"$log_file"
if UPGRADE_TEST_FAIL_MIGRATE=true bash "$fixture_root/scripts/deploy/upgrade.sh" \
  "$temporary_directory/test.env" "$temporary_directory/backups" \
  >"$temporary_directory/failure.out" 2>"$temporary_directory/failure.err"; then
  echo "迁移失败时升级脚本不应继续启动服务。" >&2
  exit 1
fi
assert_log "validate,build,stop,backup,migrate"

echo "升级脚本停服、备份、迁移与启动顺序测试通过。"
