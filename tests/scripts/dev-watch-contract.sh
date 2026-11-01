#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmpdir="$(mktemp -d)"
supervisor_pid=""
child_pid=""
supervisor_hung=0

# Bounded stop: the signal, up to 7 s for the supervisor to exit (its child
# gets 5 s before SIGKILL), then SIGKILL; `wait` only reaps a dead process.
stop_supervisor() {
  local signal="$1"
  local pid="$supervisor_pid"
  [[ -n "$pid" ]] || return 0
  kill "-$signal" "$pid" 2>/dev/null || true
  local attempt
  for attempt in $(seq 1 140); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.05
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    supervisor_hung=1
  fi
  wait "$pid" 2>/dev/null || true
  supervisor_pid=""
}

cleanup() {
  stop_supervisor TERM
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -KILL "$child_pid" 2>/dev/null || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$tmpdir/src"
cat > "$tmpdir/entry.ts" <<'EOF'
import { readFile, writeFile } from "node:fs/promises";

const counter = process.env.BOOT_COUNTER!;
let count = 0;
try {
  count = Number(await readFile(counter, "utf8"));
} catch {
  // The first boot creates the counter.
}
count += 1;
await writeFile(counter, String(count));
process.stdout.write(`boot ${count}\n`);
setInterval(() => {}, 1_000);
EOF
printf 'export const value = 0;\n' > "$tmpdir/src/change.ts"
start_supervisor() {
  printf '0' > "$tmpdir/boots"
  : > "$tmpdir/log"
  (cd "$tmpdir" && exec env BOOT_COUNTER="$tmpdir/boots" bun "$repo_root/scripts/dev-watch.ts" entry.ts --root "$tmpdir/src") >"$tmpdir/log" 2>&1 &
  supervisor_pid=$!
}

start_supervisor

fail() {
  printf 'dev-watch contract failed: %s\n' "$1" >&2
  cat "$tmpdir/log" >&2
  exit 1
}

read_boots() {
  cat "$tmpdir/boots"
}

restart_count() {
  grep -c '^\[dev-watch\] restart:' "$tmpdir/log" || true
}

wait_for_boots() {
  local expected="$1"
  local attempt
  for attempt in $(seq 1 100); do
    [[ "$(read_boots)" == "$expected" ]] && return 0
    sleep 0.05
  done
  fail "expected boot count $expected, got $(read_boots)"
}

# The counts must reach the expected values, then STAY there for a settle
# period: a delayed duplicate event would show up as a second restart.
assert_one_restart() {
  local expected_boots="$1"
  local expected_restarts="$2"
  wait_for_boots "$expected_boots"
  local attempt
  for attempt in $(seq 1 12); do
    sleep 0.05
    [[ "$(read_boots)" == "$expected_boots" ]] || fail "expected $expected_boots boots to stay stable, got $(read_boots)"
    [[ "$(restart_count)" == "$expected_restarts" ]] || fail "expected $expected_restarts restart lines to stay stable, got $(restart_count)"
  done
}

assert_no_restart() {
  local before_boots="$1"
  local before_restarts="$2"
  local attempt
  for attempt in $(seq 1 12); do
    sleep 0.05
    [[ "$(read_boots)" == "$before_boots" ]] || fail "irrelevant path triggered a restart"
    [[ "$(restart_count)" == "$before_restarts" ]] || fail "irrelevant path logged a restart"
  done
}

wait_for_boots 1

printf 'export const value = 1;\n' > "$tmpdir/src/change.ts"
assert_one_restart 2 1
printf 'export const value = 2;\n' > "$tmpdir/src/change.new"
mv "$tmpdir/src/change.new" "$tmpdir/src/change.ts"
assert_one_restart 3 2
printf 'export const value = 3;\n' > "$tmpdir/src/change.new"
mv "$tmpdir/src/change.new" "$tmpdir/src/change.ts"
assert_one_restart 4 3
printf 'export const added = true;\n' > "$tmpdir/src/added.new"
mv "$tmpdir/src/added.new" "$tmpdir/src/added.ts"
assert_one_restart 5 4
# A burst of writes inside the debounce window is one restart.
for value in 4 5 6 7 8; do
  printf 'export const value = %s;\n' "$value" > "$tmpdir/src/change.ts"
done
assert_one_restart 6 5

mkdir -p "$tmpdir/src/node_modules"
printf 'export const ignored = true;\n' > "$tmpdir/src/change.test.ts"
assert_no_restart 6 5
printf 'export const ignored = true;\n' > "$tmpdir/src/node_modules/ignored.ts"
assert_no_restart 6 5

# Stopping the supervisor with SIGTERM (make, bun run --no-orphans) and with
# SIGINT (Ctrl-C) must leave no fixture child behind, within the bound.
assert_stop_cleans_child() {
  local signal="$1"
  child_pid="$(pgrep -P "$supervisor_pid" | head -n 1 || true)"
  [[ -n "$child_pid" ]] || fail "could not find the running fixture child before SIG$signal"
  stop_supervisor "$signal"
  [[ "$supervisor_hung" == "0" ]] || fail "supervisor did not exit within 7 s of SIG$signal"
  local attempt
  for attempt in $(seq 1 100); do
    if ! kill -0 "$child_pid" 2>/dev/null; then
      child_pid=""
      return 0
    fi
    sleep 0.05
  done
  fail "fixture child $child_pid survived supervisor SIG$signal"
}

assert_stop_cleans_child TERM
start_supervisor
wait_for_boots 1
assert_stop_cleans_child INT

# A restart or a shutdown stops the child on purpose: never reported as a
# crash. A child that dies at boot is reported loudly, naming the app (the
# directory it runs in) and repeating its own error line.
if grep -q 'CRASHED' "$tmpdir/log"; then fail "a deliberate stop was reported as a crash"; fi
mkdir -p "$tmpdir/worker/src"
printf 'throw new Error("Transactional email requires TRANSACTIONAL_EMAIL_FROM.");\n' > "$tmpdir/worker/entry.ts"
: > "$tmpdir/log"
(cd "$tmpdir/worker" && exec env NO_COLOR=1 bun "$repo_root/scripts/dev-watch.ts" entry.ts --root "$tmpdir/worker/src") >"$tmpdir/log" 2>&1 &
supervisor_pid=$!
for attempt in $(seq 1 100); do
  grep -q 'CRASHED' "$tmpdir/log" && break
  sleep 0.05
done
grep -q '^\[dev-watch\] WORKER CRASHED (exit 1) and stays DOWN\.' "$tmpdir/log" || fail "no crash report naming the app"
grep -q '^\[dev-watch\] error: Transactional email requires TRANSACTIONAL_EMAIL_FROM\.' "$tmpdir/log" || fail "the crash report does not repeat the error line"
stop_supervisor TERM

printf 'dev-watch contract passed: 5 relevant changes restarted once each (burst included), ignored paths stayed quiet, SIGTERM and SIGINT cleaned up the child, a boot crash is reported with its error.\n'
