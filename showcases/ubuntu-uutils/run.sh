#!/bin/bash
# Inside the container: one port-anything project per utility under $OUT, from the recorded corpus of
# one seed (corpus/seed<SEED>/<util>.jsonl.gz), then spec infer -> baseline -> run -> report.
#   OUT=/out SEED=42 [UTILS="sort cut"] /ub/run.sh
# Each project's run.txt has the headline parity per candidate ("  parity NN.N%").
set -u
SEED=${SEED:-42}
mkdir -p "$OUT"
{ echo "distro: $(. /etc/os-release; echo "$PRETTY_NAME")"; echo "kernel: $(uname -r)"; echo "bwrap: $(bwrap --version)"
  echo "node: $(node --version)"; echo "port-anything: $(port-anything --version)"
  for c in /opt/gnu912/bin/sort /opt/gnu/bin/sort /opt/uu-lts/coreutils /opt/uu/coreutils /opt/uu-main/coreutils; do
    echo "$c: $($c --version 2>&1 | head -1)"; done
  echo "uutils main commit: $(cat /opt/uu-main/HEAD.txt)"; echo "GNU 9.12 tarball sha256: $(cat /opt/gnu912/SHA256.txt)"
  echo "corpus: seed $SEED"; } > "$OUT/versions.txt"

for u in ${UTILS:-base64 basename cat comm cut date dirname expr fmt head join ls nl numfmt od paste printf seq sha256sum sort split tac tail touch tr uniq wc}; do
  d=$OUT/$u; t0=$SECONDS
  rm -rf "$d"; mkdir -p "$d/port-anything/recorded"
  # date runs with a frozen clock, so output that prints the current time is the same for every side.
  clock=""
  [ "$u" = date ] && clock="
    LD_PRELOAD: /usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1
    FAKETIME: '2026-10-29 12:00:00'"
  cat > "$d/port-anything.yaml" <<EOF
version: 1
program_name: "$u"
reference:
  cmd: "/opt/gnu912/bin/$u"
candidates:
  - cmd: "/opt/gnu/bin/$u"
  - cmd: "/opt/uu-lts/coreutils $u"
  - cmd: "/opt/uu/coreutils $u"
  - cmd: "/opt/uu-main/coreutils $u"
sandbox:
  mode: local
  timeout: 5s
  env:
    LANG: en_US.UTF-8$clock
corpus:
  generator: v2
  generator_seed: 42
  budget: 1000
report:
  title: "$u: GNU coreutils 9.12 vs GNU 9.7 (Ubuntu 26.04), uutils 0.10.0 (Ubuntu 26.04), 0.12.0, main"
EOF
  gzip -dc "/ub/corpus/seed$SEED/$u.jsonl.gz" > "$d/port-anything/recorded/generated.jsonl"
  (cd "$d" && port-anything spec infer > spec.txt 2>&1; port-anything baseline > baseline.txt 2>&1
   port-anything run > run.txt 2>&1; echo "run exit $?" >> run.txt; port-anything report > /dev/null 2>&1)
  echo "$u: $((SECONDS - t0)) s" | tee -a "$OUT/timings.txt"
done
