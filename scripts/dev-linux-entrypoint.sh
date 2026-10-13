#!/bin/sh
# Entrypoint of the Linux dev container (started by scripts/dev-linux.sh as root).
# Hands the dependency volumes to the caller's uid/gid, installs the workspace
# dependencies, then runs the command as that user.
set -eu

uid=${PA_DEV_UID:-1000}
gid=${PA_DEV_GID:-1000}
home=/home/dev

# Tools such as git look the user up in /etc/passwd.
getent group "$gid" >/dev/null || groupadd -g "$gid" dev
getent passwd "$uid" >/dev/null || useradd -u "$uid" -g "$gid" -d "$home" -M -s /bin/bash dev \
  2>/dev/null # macOS uids (501) are below UID_MIN, which only warns
mkdir -p "$home" /pnpm/store
chown "$uid:$gid" "$home" /pnpm /pnpm/store /repo/node_modules /repo/packages/*/node_modules

as_user() {
  setpriv --reuid="$uid" --regid="$gid" --clear-groups env HOME="$home" USER=dev "$@"
}

if [ -z "${PA_DEV_NO_INSTALL:-}" ]; then
  log=$home/pnpm-install.log
  if ! as_user pnpm install --frozen-lockfile --prefer-offline >"$log" 2>&1; then
    cat "$log" >&2
    echo "dev-linux: pnpm install failed inside the container." >&2
    exit 1
  fi
fi

[ $# -gt 0 ] || set -- bash
exec setpriv --reuid="$uid" --regid="$gid" --clear-groups env HOME="$home" USER=dev "$@"
