# The dev container plus vhs (https://github.com/charmbracelet/vhs), for recording the
# README demo. Built by docs/demo/record.sh on top of the port-anything-dev image.
FROM port-anything-dev

# ttyd and ffmpeg for vhs, the libraries of the headless Chromium it downloads, a font.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ttyd ffmpeg fonts-dejavu-core \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
      libasound2t64 \
 && rm -rf /var/lib/apt/lists/*

ARG VHS_VERSION=0.12.1
ARG VHS_SHA256_ARM64=0b27029809fcc2ca2c381cceb854cbe03479a0f229b963e9bc3a2f2c36ffd3e7
ARG VHS_SHA256_X86_64=eb33787a5b1cebf91fe0b18bd231e2d71d36c1ff4babd99ddac1a6ab411efd10
RUN case "$(uname -m)" in \
      aarch64) arch=arm64 sha=$VHS_SHA256_ARM64 ;; \
      x86_64) arch=x86_64 sha=$VHS_SHA256_X86_64 ;; \
      *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSLo /tmp/vhs.tar.gz "https://github.com/charmbracelet/vhs/releases/download/v$VHS_VERSION/vhs_${VHS_VERSION}_Linux_$arch.tar.gz" \
 && echo "$sha  /tmp/vhs.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/vhs.tar.gz -C /usr/local/bin --strip-components=1 --wildcards '*/vhs' \
 && rm /tmp/vhs.tar.gz \
 && vhs --version

# vhs drives a headless Chromium; the one it would download has no Linux arm64 build, so install
# Playwright's (built for both architectures) and put it on PATH, where vhs looks first.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium \
 && ln -s "$(ls -d /opt/playwright/chromium-*/chrome-linux*/chrome)" /usr/local/bin/chromium \
 && chromium --headless=new --no-sandbox --version

# Chromium's own sandbox can't start inside the container (the demo still runs in bwrap).
ENV VHS_NO_SANDBOX=true
