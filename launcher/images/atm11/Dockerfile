# ATM11 (All The Mods 11) — NeoForge 26.1.2 / Java 25
#
# 設計方針 (ADR 0002):
#   - mods/config/libraries/world は bind volume (/data) で渡す。image には焼かない。
#   - SIGTERM を entrypoint.sh の trap が捕捉して rcon save-all → stop を発火。
#   - startserver.sh の auto-restart ループは使わず java を直接起動 (& + wait)。
#   - RCON は localhost のみで Listen、外部公開しない。

FROM eclipse-temurin:25-jre-noble

# mcrcon を GitHub release から取得。tini で signal forwarding を確実にする。
ARG MCRCON_VERSION=0.7.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tini; \
    curl -L -o /tmp/mcrcon.tar.gz \
      "https://github.com/Tiiffi/mcrcon/releases/download/v${MCRCON_VERSION}/mcrcon-${MCRCON_VERSION}-linux-x86-64.tar.gz"; \
    tar -xzf /tmp/mcrcon.tar.gz -C /usr/local/bin mcrcon; \
    chmod +x /usr/local/bin/mcrcon; \
    rm /tmp/mcrcon.tar.gz; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /opt/scripts/entrypoint.sh
COPY rcon-stop.sh /opt/scripts/rcon-stop.sh
RUN chmod +x /opt/scripts/entrypoint.sh /opt/scripts/rcon-stop.sh

# /data は volume mount point。mods/, config/, libraries/, world/, user_jvm_args.txt, server.properties が入る前提。
WORKDIR /data

# MC server port。RCON ポートは EXPOSE しない (localhost のみ)。
EXPOSE 25565/tcp

ENV NEOFORGE_VERSION=26.1.2.48-beta \
    RCON_PORT=25575

# tini を PID 1 にして SIGTERM を entrypoint.sh に渡す。
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/scripts/entrypoint.sh"]
