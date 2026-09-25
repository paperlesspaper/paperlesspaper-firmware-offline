// Run the actual production HTTP download function with deterministic HTTP/SPI backends.
#define main storageCasesMain
#include "storage_test.cpp"
#undef main
#include <cstring>
#include "device_wake.h"
using String = std::string;
// Arduino String operations used by the extracted production function.
class ArduinoString : public std::string {
public:
    using std::string::string;
    ArduinoString(const std::string &s) : std::string(s) {}
    bool startsWith(const char *s) const { return rfind(s, 0) == 0; }
    ArduinoString substring(size_t pos) const { return ArduinoString(substr(pos)); }
};
#define String ArduinoString
struct {
    String httpAuthUser, httpAuthPassword, lastModified;
    bool forceDownload = false;
    int imageMode = 1;
    String downloadUrl = "http://fixture/device/current.bmp";
    int timeout = 3600;
    bool motionWakeup = false;
} settings;
static String tempLastModified;
static bool downloadedDirectBmp;
static int serverSuggestedSleepSeconds;
static uint32_t serverSleepHeaderAtMs;
static int httpFileSize;
static SerialFlashFile saveFile;
static const int EEPROM_SETTINGS_ADR = 0, HTTP_CODE_OK = 200, HTTP_CODE_NOT_MODIFIED = 304, WL_CONNECTED = 3;
static void saveSettingsToFlash(int) {}
static unsigned transactionStarts;
static bool imageTransaction(bool start) {
    if (start) ++transactionStarts;
    return true;
}
static bool discardHttpImages() { return ImageStorage::discard(ImageStorage::IMAGE_SLOT); }
static uint32_t clockMs = 1000;
static unsigned long millis() { return clockMs; }
static void delay(int) {}
static int wifiStatus = WL_CONNECTED;
struct { void setSleep(bool) {} void disconnect(bool) {} void begin(const char *, const char *) {} int status() { return wifiStatus; } } WiFi;
struct WiFiClientSecure { void setInsecure() {} };
static std::vector<uint8_t> response;
static std::string requestedUrl, responseEtag, responseLastModified, responseSleep;
static std::vector<std::pair<std::string, std::string>> requestHeaders;
static int responseStatus = HTTP_CODE_OK;
static size_t disconnectAt;
struct FakeStream {
    size_t pos = 0;
    void setTimeout(int) {}
    int available() { return std::min(response.size(), disconnectAt) - pos; }
    size_t readBytes(uint8_t *out, size_t count) { return read(out, count); }
    int read(uint8_t *out, size_t count) {
        count = std::min(count, size_t(available()));
        memcpy(out, response.data() + pos, count);
        pos += count;
        return count;
    }
};
struct HTTPClient {
    FakeStream stream;
    void begin(const String &url) { requestedUrl = url; }
    void begin(WiFiClientSecure &, const String &url) { begin(url); }
    void setTimeout(int) {}
    void setReuse(bool) {}
    void setAuthorization(const char *, const char *) {}
    void addHeader(const String &name, const String &value) { requestHeaders.emplace_back(name, value); }
    std::vector<std::string> collected;
    bool didGet = false;
    void collectHeaders(const char **keys, int count) {
        assert(!didGet);
        for (int i = 0; i < count; ++i) collected.emplace_back(keys[i]);
    }
    int GET() { didGet = true; return responseStatus; }
    String header(const char *name) {
        assert(didGet);
        assert(std::find(collected.begin(), collected.end(), name) != collected.end());
        if (!strcmp(name, "ETag")) return String(responseEtag);
        if (!strcmp(name, "Last-Modified")) return String(responseLastModified);
        if (!strcmp(name, "X-OpenPaper-Sleep-Seconds")) return String(responseSleep);
        return String();
    }
    void end() {}
    int getSize() { return response.size(); }
    FakeStream *getStreamPtr() { return &stream; }
    bool connected() { return stream.available() > 0; }
};
#define EPD_TYPE_13INCH
#include "download_function.inc"
struct DisplayGuard { ~DisplayGuard() {} };
static void debugFS() {}
static String getRedirect(String url) { return url; }
static struct { String ssid, pss; } wifiSettings;
#include "load_function.inc"
static bool imageStorageReady = true, bleImageApplied = false;
static bool conversionWriteOk, imageTransactionActive;
static void *bleWriteBuffer = nullptr;
#include <atomic>
static std::atomic<bool> httpStorageBusy{false};
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#include "process_function.inc"
#pragma GCC diagnostic pop
static struct { int sleepPrediction = 3600; } systemData;
static constexpr int DEFAULT_SLEEP = 3600;
static int sleptSeconds;
static void gotToDeepSleep(int seconds, bool, bool) { sleptSeconds = seconds; }
static void sleepResult(int dlSuccess) {
#include "sleep_function.inc"
}
static unsigned displayCalls;
static int setImageFromFS(String) { ++displayCalls; clockMs += 27000; return 0; }
static void displaySetText(const char *, bool) {}
static int renderResult(int dlSuccess) {
    String fileName = "tmp.bmp";
#include "render_function.inc"
    return setSuccess;
}
int main() {
    reset(1048576);
    response.resize(960118);
    responseSleep = "3555";
    disconnectAt = response.size();
    for (unsigned i = 0; i < 24; ++i) {
        std::fill(response.begin(), response.end(), uint8_t(i + 1));
        std::fill(response.begin(), response.begin() + 118, 0);
        response[0] = 'B'; response[1] = 'M'; response[26] = 1; response[28] = 4;
        auto put32 = [](unsigned at, uint32_t val) { memcpy(response.data() + at, &val, 4); };
        put32(2, response.size()); put32(10, 118); put32(14, 40);
        put32(18, 1200); put32(22, uint32_t(-1600));
        String url = "http://fixture/image/" + std::to_string(i) + ".bmp";
        responseEtag = "\"hash-" + std::to_string(i) + "\"";
        responseLastModified = "date-" + std::to_string(i);
        if (i == 5) {
            disconnectAt = 4096;
            assert(downloadAndSaveFile("tmp_raw.bin", url) < 0);
            assert(serverSuggestedSleepSeconds == 0);
            assert(!ImageStorage::logicalLength());
            disconnectAt = response.size();
        }
        if (i == 10) {
            cutAfter = 100;
            try { downloadAndSaveFile("tmp_raw.bin", url); assert(false); }
            catch (const PowerCut &) {}
            cutAfter = -1;
            SerialFlash.begin(21);
            assert(!ImageStorage::logicalLength());
        }
        assert(downloadAndSaveFile("tmp_raw.bin", url) == 0);
        assert(serverSuggestedSleepSeconds == 3555);
        assert(serverSleepHeaderAtMs == clockMs);
        unsigned beforeDisplay = displayCalls;
        assert(renderResult(0) == 0 && displayCalls == beforeDisplay + 1);
        assert(DeviceWake::remainingSleepSeconds(serverSuggestedSleepSeconds, serverSleepHeaderAtMs, clockMs) == 3528);
        assert(requestedUrl == url && downloadedDirectBmp);
        assert(ImageStorage::logicalLength() == response.size());
        assert(allocations == 1 && directoryErases == 0 && ImageStorage::inspect().tailFree == 0);
        auto file = SerialFlash.open(ImageStorage::IMAGE_SLOT);
        std::vector<uint8_t> actual(response.size());
        assert(file.read(actual.data(), actual.size()) == actual.size() && actual == response);
        file.close();
        SerialFlash.begin(21);
    }

    auto stored = std::vector<uint8_t>(response.size());
    auto file = SerialFlash.open(ImageStorage::IMAGE_SLOT);
    assert(file.read(stored.data(), stored.size()) == stored.size());
    file.close();
    unsigned startsBeforeSkip = transactionStarts;
    requestHeaders.clear();
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);
    assert(transactionStarts == startsBeforeSkip);
    assert(requestHeaders.size() == 1);
    assert(requestHeaders[0].first == "If-None-Match");
    assert(requestHeaders[0].second == responseEtag);
    file = SerialFlash.open(ImageStorage::IMAGE_SLOT);
    std::vector<uint8_t> afterSkip(response.size());
    assert(file.read(afterSkip.data(), afterSkip.size()) == afterSkip.size() && afterSkip == stored);
    file.close();

    const unsigned writesBefore304 = flashWrites, erasesBefore304 = blockErases;
    responseStatus = HTTP_CODE_NOT_MODIFIED;
    responseSleep = "600";
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);
    assert(serverSuggestedSleepSeconds == 600);
    assert(transactionStarts == startsBeforeSkip && allocations == 1);
    unsigned beforeDisplay = displayCalls;
    settings.forceDownload = true;
    int unchanged = loadImageFromWeb(requestedUrl, "tmp_raw.bin");
    assert(unchanged == 1 && renderResult(unchanged) == 0);
    assert(displayCalls == beforeDisplay && transactionStarts == startsBeforeSkip && allocations == 1);
    assert(flashWrites == writesBefore304 && blockErases == erasesBefore304);
    settings.forceDownload = false;
    for (int status : {500, 404, -1}) {
        responseStatus = status;
        serverSuggestedSleepSeconds = 3555;
        assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) < 0);
        assert(serverSuggestedSleepSeconds == 0 && serverSleepHeaderAtMs == 0);
    }
    for (int status : {HTTP_CODE_OK, HTTP_CODE_NOT_MODIFIED}) {
        responseStatus = status;
        for (int seconds : {60, 3555, 86400}) {
            responseSleep = std::to_string(seconds);
            assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);
            assert(serverSuggestedSleepSeconds == seconds);
        }
        for (const char *header : {"", "invalid", " 300", "4294967356"}) {
            responseSleep = header;
            serverSuggestedSleepSeconds = 3555;
            assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);
            assert(serverSuggestedSleepSeconds == 0 && serverSleepHeaderAtMs == 0);
        }
    }
    responseStatus = HTTP_CODE_OK;

    responseSleep = "not-a-number";
    serverSuggestedSleepSeconds = 600;
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);
    assert(serverSuggestedSleepSeconds == 0);
    responseSleep = "3555";

    responseEtag.clear();
    responseLastModified = "stable-date";
    settings.lastModified = "last-modified:stable-date";
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);
    settings.lastModified = "stable-date";
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);

    responseEtag.assign(200, 'x');
    settings.lastModified = "last-modified:stable-date";
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 1);

    reset(1048576);
    responseEtag = "\"same-validator-but-no-local-file\"";
    responseLastModified.clear();
    settings.lastModified = "etag:\"same-validator-but-no-local-file\"";
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) == 0);
    assert(ImageStorage::logicalLength() == response.size());

    // A 304 without a committed slot cannot supply a valid schedule.
    reset(1048576);
    responseStatus = HTTP_CODE_NOT_MODIFIED;
    responseSleep = "3555";
    assert(downloadAndSaveFile("tmp_raw.bin", requestedUrl) < 0);
    assert(serverSuggestedSleepSeconds == 0);
    serverSuggestedSleepSeconds = 3555;
    wifiStatus = 0;
    int failed = processHttpDownload("tmp.bmp");
    assert(failed < 0 && serverSuggestedSleepSeconds == 0 && serverSleepHeaderAtMs == 0);
    for (int interval : {-1, 1, 60, 100, 300, 3600}) {
        settings.timeout = interval;
        systemData.sleepPrediction = interval;
        serverSuggestedSleepSeconds = 3555; // even stale state must not override failure
        sleepResult(failed);
        assert(sleptSeconds >= 60 && sleptSeconds <= 300);
        assert(settings.timeout == interval);
    }
    settings.timeout = systemData.sleepPrediction = 3600;
    serverSuggestedSleepSeconds = 0;
    sleepResult(1);
    assert(sleptSeconds == 3600 && settings.timeout == 3600);
    settings.timeout = 0;
    sleepResult(1);
    assert(sleptSeconds == DEFAULT_SLEEP);
    settings.timeout = 3600;
    serverSuggestedSleepSeconds = 3555;
    serverSleepHeaderAtMs = 0xfffffff0U;
    clockMs = 26984U;
    sleepResult(1);
    assert(sleptSeconds == 3528 && settings.timeout == 3600);
    std::puts("PASS: production network failure, local fallback, retry bounds and wrapped timetable; unchanged display calls=0");
    std::puts("PASS: 24 production downloads plus ETag, Last-Modified, HTTP 304 and missing-slot validation; allocations=1");
}
