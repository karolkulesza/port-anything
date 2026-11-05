#!/bin/bash
# Replays the one-line examples on every build: GNU 9.12, GNU 9.7, uutils 0.10.0, 0.12.0, main. Run inside the image:
#   docker run --rm ubuntu-uutils bash /ub/examples.sh
cd "$(mktemp -d)"
impls=("G912:/opt/gnu912/bin/" "G97:/opt/gnu/bin/" "u010:/opt/uu-lts/coreutils " "u012:/opt/uu/coreutils " "main:/opt/uu-main/coreutils ")
printf 'apple\nBanana\ncherry\n' > a; printf 'Apple\nbanana\ncherry\n' > b; printf '3\n1\n2\n' > n.txt
mkdir home && touch home/Desktop home/Documents home/Videos home/snap home/test.sh
ex() { # name, LC_ALL, stdin(printf fmt or -), util, args...
  local name=$1 loc=$2 in=$3; shift 3; local u=$1; shift
  echo "== $name"
  for i in "${impls[@]}"; do
    local tag=${i%%:*} pre=${i#*:} out
    if [ "$in" = - ]; then out=$(LC_ALL=$loc timeout 5 $pre$u "$@" 2>&1 </dev/null; echo "[exit $?]")
    else out=$(printf "$in" | LC_ALL=$loc timeout 5 $pre$u "$@" 2>&1; echo "[exit ${PIPESTATUS[1]}]"); fi
    printf '  %-5s %s\n' "$tag" "$(echo "$out" | tr '\n' '|' | cut -c1-110)"
  done
}
ex head-v C.UTF-8 'a\n' head -v
ex cut-F C.UTF-8 'a b\n' cut -F 2
ex nl-v-1 C.UTF-8 'x\ny\n' nl -v -1
ex od-w-file C.UTF-8 - od -w n.txt
ex sort-parallel C.UTF-8 - sort --parallel 100000 n.txt
ex numfmt-invalid-utf8 C.UTF-8 '1 \xff\n' numfmt
ex numfmt-field-invalid-utf8 C.UTF-8 '\xff 1\n' numfmt --field 2
ex wc-m-invalid-byte C.UTF-8 'a\xcdb\n' wc -m
ex sort-locale-f en_US.UTF-8 'b\nB\na\nA\n_x\n.y\nab\naB\n' sort -f
ex sort-locale-d en_US.UTF-8 'a b\na-b\nab\nAB\n' sort -d
ex sort-locale-k2f en_US.UTF-8 'x b\nx B\nx a\n' sort -k2f
ex uniq-utf8-s en_US.UTF-8 '\xc3\xa9ab\n\xc3\xbcab\n' uniq -s1
ex uniq-utf8-Ds en_US.UTF-8 '\xc3\xa9ab\n\xc3\xbcab\n' uniq -D -s1
ex sort-n-ties en_US.UTF-8 'b\nB\na\nA\n' sort -n
ex comm-ex en_US.UTF-8 - comm -12 a b
ex ls-home en_US.UTF-8 - ls home
