#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
struct TestSerial {
    template <class... Args> void printf(const char *format, Args... args) {
        std::printf(format, args...);
    }
    void print(const char *text) { std::fputs(text, stdout); }
    template <class T> void println(const T &text) { std::puts(text.c_str()); }
    void println(const char *text) { std::puts(text); }
};
extern TestSerial Serial;
