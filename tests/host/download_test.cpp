// Run the actual production HTTP download function with deterministic HTTP/SPI backends.
#define main storageCasesMain
#include "storage_test.cpp"
#undef main
#include <cstring>
using String = std::string;
// Arduino String operations used by the extracted production function.
class ArduinoString : public std::string {
public:
    using std::string::string;
    ArduinoString(const std::string &s) : std::string(s) {}
    bool startsWith(const char *s) const { return rfind(s, 0) == 0; }
};
#define String ArduinoString
struct {
    String httpAuthUser, httpAuthPassword, lastModified;
} settings;
static String tempLastModified;
static bool downloadedDirectBmp;
static int httpFileSize;
static SerialFlashFile saveFile;
static const int EEPROM_SETTINGS_ADR = 0, HTTP_CODE_OK = 200, WL_CONNECTED = 3;
static void saveSettingsToFlash(int) {}
static bool imageTransaction(bool) { return true; }
static bool discardHttpImages() { return ImageStorage::discard(ImageStorage::IMAGE_SLOT); }
static unsigned long millis() { return 0; }
static void delay(int) {}
struct { void setSleep(bool) {} int status() { return WL_CONNECTED; } } WiFi;
struct WiFiClientSecure { void setInsecure() {} };
static std::vector<uint8_t> response;
static std::string requestedUrl, responseHash;
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
    void collectHeaders(const char **, int) {}
    int GET() { return HTTP_CODE_OK; }
    String header(const char *) { return String(responseHash); }
    void end() {}
    int getSize() { return response.size(); }
    FakeStream *getStreamPtr() { return &stream; }
    bool connected() { return stream.available() > 0; }
};
#define EPD_TYPE_13INCH
#include "download_function.inc"
int main() {
    reset(1048576);
    response.resize(960118);
    disconnectAt = response.size();
    for (unsigned i = 0; i < 24; ++i) {
        std::fill(response.begin(), response.end(), uint8_t(i + 1));
        std::fill(response.begin(), response.begin() + 118, 0);
        response[0] = 'B'; response[1] = 'M'; response[26] = 1; response[28] = 4;
        auto put32 = [](unsigned at, uint32_t val) { memcpy(response.data() + at, &val, 4); };
        put32(2, response.size()); put32(10, 118); put32(14, 40);
        put32(18, 1200); put32(22, uint32_t(-1600));
        String url = "http://fixture/image/" + std::to_string(i) + ".bmp";
        responseHash = "hash-" + std::to_string(i);
        settings.lastModified = responseHash; // even colliding validators cannot suppress a new URL
        if (i == 5) {
            disconnectAt = 4096;
            assert(downloadAndSaveFile("tmp_raw.bin", url) < 0);
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
        assert(requestedUrl == url && downloadedDirectBmp);
        assert(ImageStorage::logicalLength() == response.size());
        assert(allocations == 1 && directoryErases == 0 && ImageStorage::inspect().tailFree == 0);
        auto file = SerialFlash.open(ImageStorage::IMAGE_SLOT);
        std::vector<uint8_t> actual(response.size());
        assert(file.read(actual.data(), actual.size()) == actual.size() && actual == response);
        file.close();
        SerialFlash.begin(21);
    }
    std::puts("PASS: 24 production HTTP downloads, changing URL/hash/content, disconnect and power cut; allocations=1");
}
