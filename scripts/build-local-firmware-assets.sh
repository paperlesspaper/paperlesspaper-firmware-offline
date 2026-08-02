#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PIO_ENV="${PIO_ENV:-ESP32-C6-DevKitM-1}"
ARTIFACT_DIR="${ROOT_DIR}/build-artifacts/firmware"
FACTORY_DIR="${ARTIFACT_DIR}/factory"
TYPES_FILE="${ROOT_DIR}/src/types.h"
TYPES_BACKUP="$(mktemp)"

if command -v pio >/dev/null 2>&1; then
  PIO_CMD=(pio)
elif [ -x "${HOME}/.local/bin/pio" ]; then
  PIO_CMD=("${HOME}/.local/bin/pio")
elif python3 -m platformio --version >/dev/null 2>&1; then
  PIO_CMD=(python3 -m platformio)
else
  echo "PlatformIO CLI is required. Install it first: pip install platformio" >&2
  exit 1
fi

mkdir -p "${FACTORY_DIR}"
cp "${TYPES_FILE}" "${TYPES_BACKUP}"

cleanup() {
  cp "${TYPES_BACKUP}" "${TYPES_FILE}"
  rm -f "${TYPES_BACKUP}" "${TYPES_FILE}.bak"
}
trap cleanup EXIT

set_display_type() {
  local display="$1"
  if [ "${display}" = "epd13" ]; then
    sed -i.bak \
      -e 's|^#define EPD_TYPE_13INCH|#define EPD_TYPE_13INCH|' \
      -e 's|^// #define EPD_TYPE_13INCH|#define EPD_TYPE_13INCH|' \
      -e 's|^#define EPD_TYPE_7INCH|// #define EPD_TYPE_7INCH|' \
      -e 's|^// #define EPD_TYPE_7INCH|// #define EPD_TYPE_7INCH|' \
      "${TYPES_FILE}"
  else
    sed -i.bak \
      -e 's|^#define EPD_TYPE_13INCH|// #define EPD_TYPE_13INCH|' \
      -e 's|^// #define EPD_TYPE_13INCH|// #define EPD_TYPE_13INCH|' \
      -e 's|^#define EPD_TYPE_7INCH|#define EPD_TYPE_7INCH|' \
      -e 's|^// #define EPD_TYPE_7INCH|#define EPD_TYPE_7INCH|' \
      "${TYPES_FILE}"
  fi
}

build_variant() {
  local display="$1"
  local suffix="$2"

  set_display_type "${display}"
  "${PIO_CMD[@]}" run -e "${PIO_ENV}"

  cp ".pio/build/${PIO_ENV}/firmware.bin" "${ARTIFACT_DIR}/firmware_offline_${suffix}.bin"
  cp ".pio/build/${PIO_ENV}/firmware.bin" "${FACTORY_DIR}/firmware_${suffix}_pre.bin"

  cat > "${FACTORY_DIR}/espfota_${suffix}_pre.json" <<EOF
{
  "version": "$(git --no-pager describe --always --dirty 2>/dev/null || echo local-build)",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "url": "./factory/firmware_${suffix}_pre.bin"
}
EOF
}

build_variant epd13 epd13
build_variant epd7 epd7

echo "Local firmware assets generated in ${ARTIFACT_DIR}"
