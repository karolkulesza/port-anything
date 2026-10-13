#!/bin/sh
# Smoke test for the Linux dev container. Run it through the wrapper:
#   scripts/dev-linux.sh scripts/dev-linux-smoke.sh
# Checks that every tool the container promises is there, that bubblewrap can
# build an unprivileged sandbox without network, and that we are not root.
set -u

fail=0
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
check() {
  name=$1; shift
  if out=$("$@" 2>&1); then ok "$name"; else bad "$name: $(printf '%s' "$out" | head -n 3)"; fi
}

if [ "$(uname -s)" = Linux ]; then ok "running on Linux"; else bad "not running on Linux ($(uname -s))"; fi
if [ "$(id -u)" != 0 ]; then ok "not root (uid $(id -u))"; else bad "running as root"; fi

check "node 22" sh -c 'node --version | grep -q "^v22\."'
check "pnpm" pnpm --version
check "bwrap" bwrap --version
check "strace" strace -V
check "GNU coreutils (gnu-prefixed)" sh -c 'gnusort --version | grep -q "GNU coreutils"'
check "uutils coreutils" sh -c 'coreutils --version 2>&1 | grep -qi uutils || sort --version | grep -qi uutils'
check "busybox" busybox true
check "toybox" toybox true
check "jq" jq --version
check "jaq" jaq --version
check "gojq" gojq --version

# bwrap starts from an empty root, so `true` must come from a bound system.
check "bwrap --unshare-net true" bwrap --ro-bind / / --unshare-net true
check "bwrap read-only system, tmpfs workdir, no network" bwrap \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-net --die-with-parent \
  sh -c 'echo x > /tmp/f && ! touch /usr/pa-write-test 2>/dev/null'
# The container itself has network; inside the sandbox an IP must be unreachable.
check "container has network" curl -sS -o /dev/null -m 10 http://1.1.1.1
check "sandbox has no network" bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net \
  sh -c '! curl -sS -o /dev/null -m 10 http://1.1.1.1 2>/dev/null'
check "strace can trace" strace -f -o /dev/null true

if [ "$fail" = 0 ]; then echo "dev container smoke test passed"; else echo "dev container smoke test FAILED"; fi
exit "$fail"
