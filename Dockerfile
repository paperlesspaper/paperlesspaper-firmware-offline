FROM node:20-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM alpine:3.20 AS firmware-assets
ARG FIRMWARE_SOURCE="local"
ARG OFFLINE_FIRMWARE_EPD7_URL="https://paperlesspaper.github.io/paperlesspaper-firmware-offline/firmware_offline_epd7.bin"
ARG OFFLINE_FIRMWARE_EPD13_URL="https://paperlesspaper.github.io/paperlesspaper-firmware-offline/firmware_offline_epd13.bin"
ARG FACTORY_JSON_EPD7_PRE_URL="http://ul.epaperframe.de/espfota_epd7_pre.json"
ARG FACTORY_JSON_EPD13_PRE_URL="http://ul.epaperframe.de/espfota_epd13_pre.json"
ARG FACTORY_FIRMWARE_EPD7_PRE_URL="http://ul.epaperframe.de/firmware_epd7_pre.bin"
ARG FACTORY_FIRMWARE_EPD13_PRE_URL="http://ul.epaperframe.de/firmware_epd13_pre.bin"

WORKDIR /assets
COPY build-artifacts/firmware/ /local-firmware/
RUN set -eu; \
    mkdir -p /assets/factory; \
    if [ "$FIRMWARE_SOURCE" = "remote" ]; then \
      wget -q -O /assets/firmware_offline_epd7.bin "$OFFLINE_FIRMWARE_EPD7_URL"; \
      wget -q -O /assets/firmware_offline_epd13.bin "$OFFLINE_FIRMWARE_EPD13_URL"; \
      wget -q -O /assets/factory/espfota_epd7_pre.json "$FACTORY_JSON_EPD7_PRE_URL"; \
      wget -q -O /assets/factory/espfota_epd13_pre.json "$FACTORY_JSON_EPD13_PRE_URL"; \
      wget -q -O /assets/factory/firmware_epd7_pre.bin "$FACTORY_FIRMWARE_EPD7_PRE_URL"; \
      wget -q -O /assets/factory/firmware_epd13_pre.bin "$FACTORY_FIRMWARE_EPD13_PRE_URL"; \
    else \
      test -s /local-firmware/firmware_offline_epd7.bin || (echo "Missing local firmware: build-artifacts/firmware/firmware_offline_epd7.bin" >&2; exit 1); \
      test -s /local-firmware/firmware_offline_epd13.bin || (echo "Missing local firmware: build-artifacts/firmware/firmware_offline_epd13.bin" >&2; exit 1); \
      test -s /local-firmware/factory/espfota_epd7_pre.json || (echo "Missing local firmware: build-artifacts/firmware/factory/espfota_epd7_pre.json" >&2; exit 1); \
      test -s /local-firmware/factory/espfota_epd13_pre.json || (echo "Missing local firmware: build-artifacts/firmware/factory/espfota_epd13_pre.json" >&2; exit 1); \
      test -s /local-firmware/factory/firmware_epd7_pre.bin || (echo "Missing local firmware: build-artifacts/firmware/factory/firmware_epd7_pre.bin" >&2; exit 1); \
      test -s /local-firmware/factory/firmware_epd13_pre.bin || (echo "Missing local firmware: build-artifacts/firmware/factory/firmware_epd13_pre.bin" >&2; exit 1); \
      cp /local-firmware/firmware_offline_epd7.bin /assets/firmware_offline_epd7.bin; \
      cp /local-firmware/firmware_offline_epd13.bin /assets/firmware_offline_epd13.bin; \
      cp /local-firmware/factory/espfota_epd7_pre.json /assets/factory/espfota_epd7_pre.json; \
      cp /local-firmware/factory/espfota_epd13_pre.json /assets/factory/espfota_epd13_pre.json; \
      cp /local-firmware/factory/firmware_epd7_pre.bin /assets/factory/firmware_epd7_pre.bin; \
      cp /local-firmware/factory/firmware_epd13_pre.bin /assets/factory/firmware_epd13_pre.bin; \
    fi

FROM nginx:1.27-alpine
ENV APP_PORT=8080 \
    APP_PROXY_1_BASE="https://corsproxy.io/?" \
    APP_PROXY_2_BASE="https://api.allorigins.win/raw?url=" \
    APP_FACTORY_PRE_JSON_BASE_URL="" \
    APP_FACTORY_PRE_BIN_BASE_URL="" \
    APP_OFFLINE_FIRMWARE_BASE_URL=""

COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/nginx/40-generate-runtime-config.sh /docker-entrypoint.d/40-generate-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-generate-runtime-config.sh

COPY --from=web-build /app/web/dist/ /usr/share/nginx/html/
COPY --from=firmware-assets /assets/firmware_offline_epd7.bin /usr/share/nginx/html/firmware_offline_epd7.bin
COPY --from=firmware-assets /assets/firmware_offline_epd13.bin /usr/share/nginx/html/firmware_offline_epd13.bin
COPY --from=firmware-assets /assets/factory/ /usr/share/nginx/html/factory/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${APP_PORT}/" || exit 1
