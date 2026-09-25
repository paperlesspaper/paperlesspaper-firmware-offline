#pragma once
#include <cstdint>

namespace ImageFormat {
inline uint32_t little32(const uint8_t *header, unsigned at) {
    return uint32_t(header[at]) | uint32_t(header[at + 1]) << 8 | uint32_t(header[at + 2]) << 16 |
           uint32_t(header[at + 3]) << 24;
}
inline bool isBmp4(const uint8_t *header) {
    return header[0] == 'B' && header[1] == 'M' && header[28] == 4 && header[29] == 0;
}
inline bool validBmp4(const uint8_t *header, uint32_t length, int32_t width, int32_t height) {
    uint32_t offset = little32(header, 10);
    return isBmp4(header) && little32(header, 14) == 40 && int32_t(little32(header, 18)) == width &&
           int32_t(little32(header, 22)) == -height && header[26] == 1 && header[27] == 0 &&
           little32(header, 30) == 0 && offset >= 54 && offset <= length &&
           length - offset == uint32_t(width) * uint32_t(height) / 2 &&
           little32(header, 2) == length;
}
} // namespace ImageFormat
