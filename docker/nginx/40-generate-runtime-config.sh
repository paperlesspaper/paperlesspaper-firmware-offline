#!/bin/sh
set -eu

: "${APP_PROXY_1_BASE:=https://corsproxy.io/?}"
: "${APP_PROXY_2_BASE:=https://api.allorigins.win/raw?url=}"
: "${APP_FACTORY_PRE_JSON_BASE_URL:=}"
: "${APP_FACTORY_PRE_BIN_BASE_URL:=}"
: "${APP_OFFLINE_FIRMWARE_BASE_URL:=}"

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__APP_CONFIG__ = {
  proxy1Base: "${APP_PROXY_1_BASE}",
  proxy2Base: "${APP_PROXY_2_BASE}",
  factoryPreJsonBaseUrl: "${APP_FACTORY_PRE_JSON_BASE_URL}",
  factoryPreBinBaseUrl: "${APP_FACTORY_PRE_BIN_BASE_URL}",
  offlineFirmwareBaseUrl: "${APP_OFFLINE_FIRMWARE_BASE_URL}"
};
EOF
