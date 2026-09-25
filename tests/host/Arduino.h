#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
struct TestSerial {
    template <class... Args> void printf(const char *format, Args... args) {
        std::printf(format, args...);
    }
    void println(const char *text) { std::puts(text); }
};
extern TestSerial Serial;
