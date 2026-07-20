FROM node:20-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM alpine:3.20 AS firmware-assets
ARG OFFLINE_FIRMWARE_EPD7_URL="https://paperlesspaper.github.io/paperlesspaper-firmware-offline/firmware_offline_epd7.bin"
ARG OFFLINE_FIRMWARE_EPD13_URL="https://paperlesspaper.github.io/paperlesspaper-firmware-offline/firmware_offline_epd13.bin"
ARG FACTORY_JSON_EPD7_PRE_URL="http://ul.epaperframe.de/espfota_epd7_pre.json"
ARG FACTORY_JSON_EPD13_PRE_URL="http://ul.epaperframe.de/espfota_epd13_pre.json"
ARG FACTORY_FIRMWARE_EPD7_PRE_URL="http://ul.epaperframe.de/firmware_epd7_pre.bin"
ARG FACTORY_FIRMWARE_EPD13_PRE_URL="http://ul.epaperframe.de/firmware_epd13_pre.bin"

RUN apk add --no-cache curl
WORKDIR /assets
RUN curl -fsSL "$OFFLINE_FIRMWARE_EPD7_URL" -o firmware_offline_epd7.bin \
    && curl -fsSL "$OFFLINE_FIRMWARE_EPD13_URL" -o firmware_offline_epd13.bin

RUN mkdir -p /assets/factory \
    && curl -fsSL "$FACTORY_JSON_EPD7_PRE_URL" -o /assets/factory/espfota_epd7_pre.json \
    && curl -fsSL "$FACTORY_JSON_EPD13_PRE_URL" -o /assets/factory/espfota_epd13_pre.json \
    && curl -fsSL "$FACTORY_FIRMWARE_EPD7_PRE_URL" -o /assets/factory/firmware_epd7_pre.bin \
    && curl -fsSL "$FACTORY_FIRMWARE_EPD13_PRE_URL" -o /assets/factory/firmware_epd13_pre.bin

FROM nginx:1.27-alpine
ENV APP_PORT=8080 \
    APP_PROXY_1_BASE="https://corsproxy.io/?" \
    APP_PROXY_2_BASE="https://api.allorigins.win/raw?url=" \
    APP_FACTORY_PRE_JSON_BASE_URL="http://ul.epaperframe.de" \
    APP_FACTORY_PRE_BIN_BASE_URL="http://ul.epaperframe.de" \
    APP_OFFLINE_FIRMWARE_BASE_URL="https://paperlesspaper.github.io/paperlesspaper-firmware-offline"

COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY docker/nginx/40-generate-runtime-config.sh /docker-entrypoint.d/40-generate-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-generate-runtime-config.sh

COPY --from=web-build /app/web/dist/ /usr/share/nginx/html/
COPY --from=firmware-assets /assets/firmware_offline_epd7.bin /usr/share/nginx/html/firmware_offline_epd7.bin
COPY --from=firmware-assets /assets/firmware_offline_epd13.bin /usr/share/nginx/html/firmware_offline_epd13.bin
COPY --from=firmware-assets /assets/factory/ /usr/share/nginx/html/factory/

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null "http://127.0.0.1:${APP_PORT}/" || exit 1
