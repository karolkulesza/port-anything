#!/bin/sh
# Record the README demo (docs/demo/compare.gif) from docs/demo/compare.tape with vhs,
# in the Linux dev container. Needs Docker; run from anywhere in the checkout.
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd -P)

# The demo image builds on the dev image, so build that one first.
"$root/scripts/dev-linux.sh" true

PA_DEV_IMAGE=port-anything-demo \
PA_DEV_DOCKERFILE=docs/demo/Dockerfile \
  "$root/scripts/dev-linux.sh" sh -c 'pnpm -r build >/dev/null && vhs docs/demo/compare.tape'

ls -l "$root/docs/demo/compare.gif"
