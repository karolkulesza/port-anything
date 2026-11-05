# Ubuntu 26.04 LTS as shipped, plus the builds it is compared with:
#   GNU coreutils 9.12 (built from the GNU tarball, the reference) -> /opt/gnu912/bin/<util>
#   GNU coreutils 9.7 (Ubuntu's gnu-coreutils)                     -> /opt/gnu/bin/<util>
#   uutils 0.10.0 (Ubuntu 26.04's coreutils)                       -> /opt/uu-lts/coreutils <util>
#   uutils 0.12.0 (latest release)                                 -> /opt/uu/coreutils <util>
#   uutils main (built from source)                                -> /opt/uu-main/coreutils <util>
#   port-anything 0.1.3 from npm
# Build: docker build -t ubuntu-uutils .   (the Rust build of uutils main takes a while)
FROM rust:1 AS uumain
ARG UU_MAIN=90b48bf2c150dcec9756dba8fcb7a73bc0b1d3bc
RUN git init -q /src && cd /src && git fetch -q --depth 1 https://github.com/uutils/coreutils "$UU_MAIN" \
 && git checkout -q FETCH_HEAD && cargo build --release -q --features unix \
 && cp target/release/coreutils /coreutils && echo "$UU_MAIN" > /HEAD.txt

FROM ubuntu:26.04 AS gnu912
ARG GNU=9.12
ARG GNU_SHA256=a480198559733e9b3da999e90543ac6f888a2caa544d8d664c5a1f17e528e210
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl xz-utils \
 && curl -fsSLo /tmp/cu.tar.xz https://ftp.gnu.org/gnu/coreutils/coreutils-$GNU.tar.xz \
 && echo "$GNU_SHA256  /tmp/cu.tar.xz" | sha256sum -c - && echo "$GNU_SHA256" > /SHA256.txt \
 && mkdir /src && tar -xJf /tmp/cu.tar.xz -C /src --strip-components=1 \
 && cd /src && FORCE_UNSAFE_CONFIGURE=1 ./configure -q --prefix=/opt/gnu912 --disable-nls \
 && make -s -j"$(nproc)" && make -s install && /opt/gnu912/bin/sort --version | head -1

FROM ubuntu:26.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bubblewrap ca-certificates curl xz-utils locales faketime \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i -e 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen && locale-gen >/dev/null

ARG NODE_VERSION=22.23.3
ARG NODE_SHA256_X64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
 && echo "$NODE_SHA256_X64  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz
ARG PORT_ANYTHING=0.1.3
RUN npm install -g --no-fund --no-audit port-anything@$PORT_ANYTHING && port-anything --version

# GNU as Ubuntu ships it, under plain names (argv[0] is pinned by the tool anyway).
RUN mkdir -p /opt/gnu/bin && for f in /usr/bin/gnu*; do \
      n=${f#/usr/bin/gnu}; [ -n "$n" ] && ln -s "$f" "/opt/gnu/bin/$n"; done \
 && /opt/gnu/bin/sort --version | head -1
RUN mkdir -p /opt/uu-lts && cp /usr/bin/coreutils /opt/uu-lts/coreutils && /opt/uu-lts/coreutils --version
ARG UU=0.12.0
RUN curl -fsSL https://github.com/uutils/coreutils/releases/download/$UU/coreutils-$UU-x86_64-unknown-linux-gnu.tar.gz \
      | tar xz -C /opt && mv /opt/coreutils-$UU-x86_64-unknown-linux-gnu /opt/uu && /opt/uu/coreutils --version
COPY --from=gnu912 /opt/gnu912 /opt/gnu912
COPY --from=gnu912 /SHA256.txt /opt/gnu912/SHA256.txt
COPY --from=uumain /coreutils /opt/uu-main/coreutils
COPY --from=uumain /HEAD.txt /opt/uu-main/HEAD.txt
RUN /opt/uu-main/coreutils --version

COPY run.sh examples.sh /ub/
COPY corpus /ub/corpus
