#include <cassert>
#include <cstdint>
#include <cstdio>
#include <initializer_list>

#include "device_wake.h"

int main() {
   int seconds = 0;
   assert(DeviceWake::parseSleepSeconds("60", seconds) && seconds == 60);
   assert(DeviceWake::parseSleepSeconds("3555", seconds) && seconds == 3555);
   assert(DeviceWake::parseSleepSeconds("86400", seconds) && seconds == 86400);
   for (const char *invalid : {static_cast<const char *>(nullptr), "", "0", "59", "86401", "4294967356",
                              "2147483648", "99999999999999999999999999999999999999999",
                              " 300", "300 ", "30 0", "+300", "-300", "300s", "3.00", "\t300", "300\n"}) {
      seconds = 3555;
      assert(!DeviceWake::parseSleepSeconds(invalid, seconds));
      assert(seconds == 3555);
   }

   assert(DeviceWake::remainingSleepSeconds(3555, 1000, 28000) == 3528);
   assert(DeviceWake::remainingSleepSeconds(60, 1000, 28000) == 60);
   assert(DeviceWake::remainingSleepSeconds(3600, 0xfffffff0U, 26984U) == 3573);
   assert(DeviceWake::remainingSleepSeconds(0, 0, 0) == 0);

   assert(DeviceWake::remainingSleepSeconds(3555, 0, 4000000) == 60);
   assert(DeviceWake::retrySleepSeconds(-1) == 60);
   assert(DeviceWake::retrySleepSeconds(60) == 60);
   assert(DeviceWake::retrySleepSeconds(300) == 300);
   assert(DeviceWake::retrySleepSeconds(301) == 300);
   assert(DeviceWake::retrySleepSeconds(30) == 60);
   assert(DeviceWake::retrySleepSeconds(100) == 100);
   assert(DeviceWake::retrySleepSeconds(3600) == 300);
   std::puts("PASS: dynamic wake parsing, elapsed-time correction and retry bounds");
}
