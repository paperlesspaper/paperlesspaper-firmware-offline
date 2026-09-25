#pragma once

#include <cstdint>

namespace DeviceWake {

constexpr int MIN_SLEEP_SECONDS = 60;
constexpr int MAX_SLEEP_SECONDS = 86400;
constexpr int RETRY_SLEEP_SECONDS = 300;

inline bool parseSleepSeconds(const char *value, int &seconds) {
   if (value == nullptr || *value == '\0') return false;
   uint32_t parsed = 0;
   for (const char *cursor = value; *cursor != '\0'; ++cursor) {
      if (*cursor < '0' || *cursor > '9') return false;
      uint32_t digit = uint32_t(*cursor - '0');
      if (parsed > (uint32_t(MAX_SLEEP_SECONDS) - digit) / 10) return false;
      parsed = parsed * 10 + digit;
   }
   if (parsed < uint32_t(MIN_SLEEP_SECONDS)) return false;
   seconds = int(parsed);
   return true;
}

inline int remainingSleepSeconds(int suggestedSeconds, uint32_t receivedAtMs, uint32_t nowMs) {
   if (suggestedSeconds < MIN_SLEEP_SECONDS || suggestedSeconds > MAX_SLEEP_SECONDS) return 0;
   uint32_t elapsedSeconds = (nowMs - receivedAtMs) / 1000;
   if (elapsedSeconds + MIN_SLEEP_SECONDS >= uint32_t(suggestedSeconds)) return MIN_SLEEP_SECONDS;
   return suggestedSeconds - int(elapsedSeconds);
}

inline int retrySleepSeconds(int configuredSeconds) {
   if (configuredSeconds < MIN_SLEEP_SECONDS) return MIN_SLEEP_SECONDS;
   if (configuredSeconds > RETRY_SLEEP_SECONDS) return RETRY_SLEEP_SECONDS;
   return configuredSeconds;
}

} // namespace DeviceWake
