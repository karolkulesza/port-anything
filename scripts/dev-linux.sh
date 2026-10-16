#!/bin/sh
# Run a command in the Linux dev container with this checkout mounted at /repo.
#
#   scripts/dev-linux.sh pnpm -r test
#   scripts/dev-linux.sh bwrap --ro-bind / / --unshare-net true
#   scripts/dev-linux.sh            # interactive shell
#
# The image is built from Dockerfile.dev on first use (later runs hit the cache).
# Dependencies are installed inside the container into Docker volumes that hide the
# host's node_modules, so native packages built for macOS never leak into Linux.
# Build output (dist/) is shared with the host.
#
# Environment:
#   PA_DEV_IMAGE        image tag (default port-anything-dev)
#   PA_DEV_DOCKERFILE   Dockerfile to build it from, relative to the repo (default Dockerfile.dev)
#   PA_DEV_NO_INSTALL=1 skip `pnpm install` before the command
#   PA_DEV_DOCKER_ARGS  extra `docker run` arguments (word-split)
set -eu

root=$(cd "$(dirname "$0")/.." && pwd -P)
image=${PA_DEV_IMAGE:-port-anything-dev}
dockerfile=${PA_DEV_DOCKERFILE:-Dockerfile.dev}

if ! docker info >/dev/null 2>&1; then
  echo "dev-linux: Docker is not running. Start Docker (Desktop) and try again." >&2
  exit 125
fi

if ! build_log=$(docker build -q -t "$image" - <"$root/$dockerfile" 2>&1); then
  printf '%s\n' "$build_log" >&2
  echo "dev-linux: building $image from $dockerfile failed." >&2
  exit 125
fi

# One set of node_modules volumes per checkout (worktrees don't share them),
# one pnpm store for all of them.
key=$(printf '%s' "$root" | cksum | cut -d' ' -f1)
mounts="-v port-anything-dev-pnpm-store:/pnpm/store -v port-anything-dev-$key-root:/repo/node_modules"
for pkg in "$root"/packages/*/; do
  [ -f "$pkg/package.json" ] || continue
  name=$(basename "$pkg")
  mounts="$mounts -v port-anything-dev-$key-$name:/repo/packages/$name/node_modules"
done

tty=
if [ -t 0 ] && [ -t 1 ]; then tty=-t; fi

# seccomp=unconfined: Docker's default seccomp profile blocks the unprivileged user
# namespaces that bubblewrap needs. apparmor=unconfined: same for AppArmor hosts
# (Ubuntu 24.04+). systempaths=unconfined: lets bubblewrap mount a fresh /proc for its
# PID namespace, as on a real host. The container starts as root only to prepare the
# volumes; the command runs with the caller's uid/gid.
# shellcheck disable=SC2086 # $mounts and $PA_DEV_DOCKER_ARGS are word lists
exec docker run --rm -i $tty --init \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v "$root:/repo" $mounts \
  -e PA_DEV_UID="$(id -u)" -e PA_DEV_GID="$(id -g)" \
  -e PA_DEV_NO_INSTALL="${PA_DEV_NO_INSTALL:-}" \
  -e PA_SANDBOX_TESTS=1 \
  ${PA_DEV_DOCKER_ARGS:-} \
  "$image" /repo/scripts/dev-linux-entrypoint.sh "$@"
