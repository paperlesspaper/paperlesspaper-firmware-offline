#include <FS.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <cstdint>
#define DEST_FS_USES_SPIFFS
#include <Arduino.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
// #include <SD_MMC.h>
#include "Adafruit_GFX.h"
#include "EEPROM.h"
#include "SPIFFS.h"
#include "SdFat.h"
#include "Ticker.h"
#include "driver/rtc_io.h"
#include "kxtj3-1057.h"
#include <JPEGDEC.h>
#include <SPI.h>
#include <SerialFlash.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp_ota_ops.h>
#include <rom/crc.h>
#include <rom/rtc.h>
#include <soc/lp_aon_reg.h>

#include "chunked_decoder.h"
#include "epaper_display.h"
#include "types.h"

#if DEBUG
#define PRINTS(s)         \
   do {                   \
      Serial.print(F(s)); \
   }                      \
   while (false)
#define PRINT(s, v)       \
   do {                   \
      Serial.print(F(s)); \
      Serial.print(v);    \
   }                      \
   while (false)
#else
#define PRINTS(s)
#define PRINT(s, v)
#endif

#ifdef ARDUHAL_LOG_LEVEL
#undef ARDUHAL_LOG_LEVEL
#define ARDUHAL_LOG_LEVEL ARDUHAL_LOG_LEVEL_NONE
#endif
#define BUTTON_PIN_BITMASK(GPIO) (1ULL << GPIO) // 2 ^ GPIO_NUMBER in hex

// Pins
#define CS_SD_PIN 13
#define DISP_POWER 12

// flash
#define CS_FLASH_PIN 21

// SPI Pins
#define SCK_PIN 15
#define MOSI_PIN 4 // DIN
#define MISO_PIN 5 // DIN

// I2C
#define I2C_SDA_PIN 6
#define I2C_SCL_PIN 7
#define INT_PIN 0
#define ACC_ADDR 0x0E
#define USBC_ADDR 0x21

// Pins Periphery
#define LED_PIN 14
#define BAT_VOLT_SENSE_PIN 2
#define BAT_VOLT_EN_PIN 3
#define BUTTON_PIN 9
#define CHG_EN_PIN 22
#define CHG_STAT_PIN 23

#ifdef EPD_TYPE_13INCH
#define EPD_TYPE_IDENTIFIER "epd13-" // Type of device (screen type)
#define VDD_CORRECTION_FACTOR 6.68
#else
#define EPD_TYPE_IDENTIFIER "epd7-" // Type of device (screen type)
#define VDD_CORRECTION_FACTOR 2.28
#endif

#define uS_TO_S_FACTOR 1000000ULL /* Conversion factor for micro seconds to seconds */
#define LENGTH(x) (strlen(x) + 1) // length of char string
#define EEPROM_SIZE 2048          // EEPROM size
#define EEPROM_SETTINGS_ADR 500   // start address to store settings
#define BLE_BUFFER_SIZE 32768
#define MAX_SETTING_STRING_LEN 128 // max characters of a string setting (EEPROM slot is 130 bytes)
#define MAX_WIFI_SSID_LEN 32       // EEPROM 0-39
#define MAX_WIFI_PASS_LEN 64       // EEPROM 40-105
#define MIN_SLEEP_TIMEOUT 60       // seconds
#define MAX_SLEEP_TIMEOUT 2592000  // seconds (30 days)

#define DEFAULT_SLEEP 3600 // Default time how long to sleep after update
#define FAILSAVE_TIMER 180 // Time to shutdown the device if no reaction or hangup
#define SLEEP_RECALCULATION_PERIOD_SECONDS 30
#define SETUP_MODE_TIMEOUT 30  // seconds to wait in setup mode for BLE connection before switching to fetch/refresh mode
#define SETUP_IDLE_TIMEOUT 600 // seconds a connected BLE client may stay idle on battery power before the setup mode ends
#define LED_DIM_VALUE 5        // brightness of led in percent (0-100)

#define MAX_DOWNLOAD_SIZE 0x600000UL // largest picture file that is downloaded (6 MB), less if the flash is smaller
#define WIFI_CONNECT_TIMEOUT 20      // seconds to wait for the WiFi connection
#define MAX_SETTINGS_JSON_SIZE 4096  // largest settings JSON that is read

// Results of downloadAndSaveFile() and loadImageFromWeb()
#define DL_OK 0
#define DL_NOT_MODIFIED 1
#define DL_NO_MEMORY -1
#define DL_REQUEST_FAILED -2 // no answer from the server (connection, DNS, TLS, timeout)
#define DL_HTTP_STATUS -3    // the server answered, but not with a picture (404, 401, 500, ...)
#define DL_INCOMPLETE -4     // the connection was lost during the download
#define DL_TOO_LARGE -5      // the file does not fit into the flash
#define DL_FLASH_ERROR -8

#define EEPROM_DISPLAY_CONTENT_ADR 230
#define DISPLAY_PICTURE 0    // a picture, or unknown
#define DISPLAY_SETUP_HINT 1 // "not set up yet"
#define DISPLAY_ERROR_TEXT 2 // "picture download failed"
#define DISPLAY_BATTERY_EMPTY 3

#define BAT_OFF_VALUE 4000 // mV (4 cells): below this the frame only sleeps when it runs on batteries

#if DEBUG
const bool DEBUG_FLAG = true;
#else
const bool DEBUG_FLAG = false;
#endif

WifiSettings wifiSettings = {
    .ssid = "",
    .pss = "",
    .wifiQuality = 0,
    .wifiRetries = 0,
    .wifiIsConnected = false,
    .wifiOnboardingFailed = false,
    .bleInitOk = false,
    .isDeployWifi = false,
    .clientId = "",
};

Settings settings = {
    .timeout = DEFAULT_SLEEP,
    .lut = "default",
    .clearscreen = false,
    .showBatteryWarning = true,
    .showWifiWarning = true,
    .sleepDisabled = false,
    .downloadUrl = "",
    .httpAuthUser = "",
    .httpAuthPassword = "",
    .lastModified = "",
    .imageMode = 1,
    .motionWakeup = false,
    .chargerMode = false,
    .settingsUrl = "",
    .settingsLastModified = "",
    .autoRotation = true,
    .forceDownload = false,
    .skipSetupMode = false};

SystemData systemData = {
    .wakeupCause = SYSTEM_RESET,
    .vddValue = 5000,
    .ledDimValue = 100,
    .sleepPrediction = DEFAULT_SLEEP,
    .newSleepTimeSet = false,
    .usbConnected = true,
    .deviceOrientation = 0,
    .displayPowerOn = false,
    .sdReady = false,
};

esp_sleep_wakeup_cause_t wakeup_reason;

KXTJ3 myIMU(ACC_ADDR); // Address can be 0x0E or 0x0F
WiFiClientSecure net = WiFiClientSecure();
Preferences preferences;
Ticker tickerFailsave;
Ticker perdiodicLed;
Ticker perdiodicLedOff;
Ticker periodicAccCheck;
Ticker tickerStatupCounter;
Ticker onceDisplay;
SerialFlashFile saveFile;
SerialFlashFile rawOutFile;
SerialFlashFile jpgInFile;
SerialFlashFile bleFile;
SdFs sd;
RTC_DATA_ATTR timeval previousWakeup = timeval{.tv_sec = 0, .tv_usec = 0};
RTC_DATA_ATTR uint8_t failedUpdates = 0;
JPEGDEC jpeg;

NimBLECharacteristic *wifiConnectedCharacteristic;
NimBLECharacteristic *wifiInfoCharacteristic;
NimBLECharacteristic *wifiScanCharacteristic;
NimBLECharacteristic *systemInfoCharacteristic;

NimBLEAdvertising *pAdvertising;
static NimBLEServer *pServer;

int periodicLedTimeout = 0;
int httpFileSize = 0;
String tempLastModified = "";
int StartCounter = 0;
uint16_t bleWriteBufferPos = 0;
uint32_t bleBytesReceived = 0;
uint32_t bleRunningCrc = 0;
uint32_t bleFinalFlashCrc = 0;
uint8_t bleExpectedSeq = 0;
bool bleSeqError = false;
bool bleUploadError = false;
bool bleProtocolV2 = false;
uint16_t blePeerMtu = 247;
unsigned long lastDisconnectTime = 0;
volatile unsigned long bleLastActivity = 0;
volatile bool wifiScanRequested = false;
bool periodicLedIsOn = false;
bool downloadStart = true;
volatile bool applyPending = false;
volatile bool applyInProgress = false; // the display is being refreshed from the picture slot
bool bleDisplayBusy = false;           // an upload START was refused for that reason
bool batteryEmpty = false;
bool bleImageApplied = false;
volatile bool forceExitSetup = false;
volatile bool isBleClientConnected = false;
bool buttonWake = false; // true if wakeup via reset button
volatile bool fwUpdateInProgress = false;
volatile bool fwRebootPending = false;
unsigned long fwRebootScheduledAt = 0;
uint32_t bleExpectedFwBytes = 0;
bool stopAccRecheck = false;
bool isOrientUpdate = false;
uint32_t lastDownloadedBytes = 0;
int serverSleepSeconds = 0;
uint32_t serverSleepReceivedMs = 0;
constexpr uint32_t IMAGE_SLOT_SIZE = (EPD_WIDTH * EPD_HEIGHT / 2) + 4096;
int16_t err_curr[IMG_WIDTH * 3];
int16_t err_next[IMG_WIDTH * 3];
char CLIENT_ID[20];
uint8_t *bleWriteBuffer = nullptr;

void ledBlink(int timeout, bool on, int dimValue = 100);
void debugFS(void);
bool BleInit(String deviceId, bool enable);
void writeIntToFlash(int value, int startAddr, bool commit = true);
void writeStringToFlash(const char *toStore, int startAddr, int maxLen = MAX_SETTING_STRING_LEN, bool commit = true);
int storeSleepTimeMem(int updateTime = 0);
void gotToDeepSleep(int seconds, bool showScreen = true, bool motionWake = true);
int accInit(bool skipInit = false);
bool accIntSet(int sensity);
void checkOrientationInBackground(int setOrientValue = -1, bool isRunning = true);
bool chargeMode(bool enable);
bool usbInit();
bool usbCheckConnect();
int calculateSleepDuration(int defaultTimeout, bool forceReset, bool getDataOnly = false);
bool resetAll(bool resetWifi);
wakeup_reason_t getWakeupReason();
void runSetupMode();
int processHttpDownload(String fileName);
bool sdInit(void);
void accUpdateOrient();

uint32_t calcCRC32(const uint8_t *data, size_t len) {
   return crc32_le(0, data, len);
}

const uint32_t acep_palette[7] = {
    0x000000, // 0: Black
    0x0000FF, // 1: Blue
    0x00FF00, // 2: Green
    0xFF0000, // 3: Red
    0xFFFFFF, // 4: Unused (skipped)
    0xFFFF00, // 5: Yellow
    0xFFFFFF  // 6: White
};

void snapColor(int &r, int &g, int &b) {
   int t = 25; // Aggressive threshold for snapping to pure colors
   if (r < t && g < t && b < t) {
      r = 0;
      g = 0;
      b = 0;
      return;
   } // Black
   if (r > 255 - t && g > 255 - t && b > 255 - t) {
      r = 255;
      g = 255;
      b = 255;
      return;
   } // White
   if (r > 255 - t && g < t && b < t) {
      r = 255;
      g = 0;
      b = 0;
      return;
   } // Red
   if (r < (t + 10) && g > 255 - (t + 10) && b < (t + 10)) {
      r = 0;
      g = 255;
      b = 0;
      return;
   } // Green
   if (r < t && g < t && b > 255 - t) {
      r = 0;
      g = 0;
      b = 255;
      return;
   } // Blue
   if (r > 255 - (t + 25) && g > 255 - (t + 25) && b < (t + 25)) {
      r = 255;
      g = 255;
      b = 0;
      return;
   } // Yellow
}

uint8_t findClosestColor(int r, int g, int b) {
   uint8_t best = 6; // Default to white
   long min_dist = 2000000000;
   uint8_t valid_indices[] = {0, 1, 2, 3, 5, 6};

   for (int i = 0; i < 6; i++) {
      uint8_t idx = valid_indices[i];
      int pr = (acep_palette[idx] >> 16) & 0xFF;
      int pg = (acep_palette[idx] >> 8) & 0xFF;
      int pb = acep_palette[idx] & 0xFF;
      long dist = (long)(r - pr) * (r - pr) + (long)(g - pg) * (g - pg) + (long)(b - pb) * (b - pb);
      if (dist < min_dist) {
         min_dist = dist;
         best = idx;
      }
   }
   return best;
}

void *myOpen(const char *filename, int32_t *size) {
   jpgInFile = SerialFlash.open(filename);
   if (jpgInFile) {
      *size = (lastDownloadedBytes > 0 && lastDownloadedBytes <= jpgInFile.size())
                  ? (int32_t)lastDownloadedBytes
                  : (int32_t)jpgInFile.size();
      return (void *)1;
   }
   return NULL;
}
void myClose(void *handle) { jpgInFile.close(); }
int32_t myRead(JPEGFILE *pFile, uint8_t *pBuf, int32_t iLen) { return jpgInFile.read(pBuf, iLen); }
int32_t mySeek(JPEGFILE *pFile, int32_t iPosition) {
   jpgInFile.seek(iPosition);
   return iPosition;
}

void prepareSpiBusForFlash() {
#ifdef EPD_TYPE_13INCH
   if (!systemData.displayPowerOn) {
      pinMode(DISP_POWER, OUTPUT);
      digitalWrite(DISP_POWER, HIGH);
      systemData.displayPowerOn = true;
      Serial.println("[POWER] Supply ON for SPI bus");
      delay(100);
   }
#endif
   pinMode(CS_FLASH_PIN, OUTPUT);
   digitalWrite(CS_FLASH_PIN, HIGH);
   pinMode(CS_SD_PIN, OUTPUT);
   digitalWrite(CS_SD_PIN, HIGH);
   pinMode(CS_EPD_PIN, OUTPUT);
   digitalWrite(CS_EPD_PIN, HIGH);
   pinMode(EPD_CS_S, OUTPUT);
   digitalWrite(EPD_CS_S, HIGH);
}

bool waitFlashReady(uint32_t timeoutMs = 10000) {
   unsigned long start = millis();
   while (!SerialFlash.ready()) {
      if (millis() - start > timeoutMs) {
         Serial.println("[FLASH] ERROR: Timeout waiting for SerialFlash ready!");
         return false;
      }
      delay(1);
   }
   return true;
}

bool waitFlashIdle(uint32_t timeoutMs = 10000) {
   unsigned long startMs = millis();
   uint32_t fastPolls = 0;
   while (!SerialFlash.ready()) {
      if (millis() - startMs > timeoutMs) {
         Serial.println("[FLASH] ERROR: Timeout waiting for SerialFlash idle!");
         return false;
      }
      if (fastPolls < 40) {
         delayMicroseconds(50);
         fastPolls++;
      }
      else {
         delay(1);
      }
   }
   return true;
}

static bool writeAndVerifyRangeRaw(uint32_t startAddr, const uint8_t *buf, uint32_t len) {
   uint8_t verifyBuf[256];
   uint32_t off = 0;
   while (off < len) {
      uint32_t pageAddr = startAddr + off;
      uint32_t maxInPage = 256 - (pageAddr & 0xFF);
      uint32_t chunk = (len - off < maxInPage) ? (len - off) : maxInPage;
      bool ok = false;
      for (int attempt = 0; attempt < 3; attempt++) {
         if (!waitFlashIdle())
            return false;
         SerialFlash.write(pageAddr, buf + off, chunk);
         if (!waitFlashIdle())
            return false;
         SerialFlash.read(pageAddr, verifyBuf, chunk);
         if (memcmp(buf + off, verifyBuf, chunk) == 0) {
            ok = true;
            break;
         }
         delay(1);
      }
      if (!ok)
         return false;
      off += chunk;
   }
   return true;
}

bool writeAndVerifyFlash(SerialFlashFile &file, uint32_t fileOffset, const uint8_t *data, uint32_t len) {
   if (!file || fileOffset + len > file.size())
      return false;
   prepareSpiBusForFlash();
   uint32_t flashStart = file.getFlashAddress();
   uint32_t baseAddr = flashStart + fileOffset;
   uint8_t verifyBuf[256];
   uint32_t pos = 0;
   int blockRecoveries = 0;
   while (pos < len) {
      uint32_t pageAddr = baseAddr + pos;
      uint32_t maxInPage = 256 - (pageAddr & 0xFF);
      uint32_t chunk = (len - pos < maxInPage) ? (len - pos) : maxInPage;
      bool pageOk = false;
      for (int attempt = 0; attempt < 3; attempt++) {
         if (!waitFlashIdle())
            return false;
         SerialFlash.write(pageAddr, data + pos, chunk);
         if (!waitFlashIdle())
            return false;
         SerialFlash.read(pageAddr, verifyBuf, chunk);
         if (memcmp(data + pos, verifyBuf, chunk) == 0) {
            pageOk = true;
            break;
         }
         Serial.printf("[FLASH] WARN: Page verify mismatch at 0x%08X (attempt %d), retrying...\n",
                       pageAddr, attempt + 1);
         delay(1);
      }
      if (!pageOk) {
         uint32_t bs = SerialFlash.blockSize();
         if (bs == 0)
            bs = 65536;
         uint32_t blockBase = pageAddr & ~(bs - 1);
         if (blockRecoveries < 2 && blockBase >= flashStart && (blockBase + bs) <= (flashStart + file.size())) {
            Serial.printf("[FLASH] WARN: Re-erasing 64KB block 0x%08X to heal NOR 0-bit glitch at 0x%08X...\n",
                          blockBase, pageAddr);
            if (blockBase >= baseAddr) {
               SerialFlash.eraseBlock(blockBase);
               if (!waitFlashIdle())
                  return false;
               pos = blockBase - baseAddr;
               blockRecoveries++;
               continue;
            }
            else {
               uint32_t priorLen = baseAddr - blockBase;
               uint8_t *backup = (uint8_t *)malloc(priorLen);
               if (backup != nullptr) {
                  if (!waitFlashIdle()) {
                     free(backup);
                     return false;
                  }
                  SerialFlash.read(blockBase, backup, priorLen);
                  SerialFlash.eraseBlock(blockBase);
                  if (!waitFlashIdle()) {
                     free(backup);
                     return false;
                  }
                  bool restored = writeAndVerifyRangeRaw(blockBase, backup, priorLen);
                  free(backup);
                  if (restored) {
                     pos = 0;
                     blockRecoveries++;
                     continue;
                  }
               }
            }
         }
         Serial.printf("[FLASH] ERROR: Page verify failed permanently at 0x%08X!\n", pageAddr);
         return false;
      }
      pos += chunk;
   }
   file.seek(fileOffset + len);
   return true;
}

bool verifyFlashSlotCrc(SerialFlashFile &file, uint32_t totalLen, uint8_t *scratchBuf, uint32_t scratchSize, uint32_t &outCrc) {
   if (!file || totalLen == 0 || totalLen > file.size() || scratchBuf == nullptr || scratchSize == 0)
      return false;
   prepareSpiBusForFlash();
   if (!waitFlashIdle())
      return false;
   uint32_t baseAddr = file.getFlashAddress();
   uint32_t crc = 0;
   uint32_t pos = 0;
   while (pos < totalLen) {
      uint32_t chunk = (totalLen - pos < scratchSize) ? (totalLen - pos) : scratchSize;
      SerialFlash.read(baseAddr + pos, scratchBuf, chunk);
      crc = crc32_le(crc, scratchBuf, chunk);
      pos += chunk;
   }
   outCrc = crc;
   return true;
}

void discardFlashSlot(SerialFlashFile &file) {
   if (file) {
      prepareSpiBusForFlash();
      if (file.getFlashAddress() > 0) {
         SerialFlash.eraseBlock(file.getFlashAddress());
      }
      else {
         file.erase();
      }
      waitFlashReady();
      file.close();
      file = SerialFlashFile();
   }
}

bool prepareFlashSlot(const char *name, uint32_t requiredSize, SerialFlashFile &outFile, bool eraseSlot = true) {
   prepareSpiBusForFlash();
   uint32_t targetSize = (requiredSize > IMAGE_SLOT_SIZE) ? requiredSize : IMAGE_SLOT_SIZE;
   if (!waitFlashReady())
      return false;
   outFile = SerialFlash.open(name);
   if (!outFile || outFile.size() < targetSize) {
      if (outFile) {
         SerialFlash.remove(outFile);
         outFile.close();
      }
      if (!SerialFlash.createErasable(name, targetSize)) {
         Serial.println("[FLASH] Slot allocation failed, resetting SerialFlash directory...");
         SerialFlash.eraseBlock(0);
         if (!waitFlashReady())
            return false;
         if (strcmp(name, "tmp.bmp") != 0) {
            SerialFlash.createErasable("tmp.bmp", IMAGE_SLOT_SIZE);
            SerialFlashFile picture = SerialFlash.open("tmp.bmp");
            if (picture) {
               SerialFlash.eraseBlock(picture.getFlashAddress());
               if (!waitFlashReady())
                  return false;
            }
         }
         if (!SerialFlash.createErasable(name, targetSize)) {
            Serial.println("[FLASH] ERROR: Failed to allocate SerialFlash slot!");
            return false;
         }
      }
      outFile = SerialFlash.open(name);
   }
   if (!outFile)
      return false;
   uint32_t bs = SerialFlash.blockSize();
   if (bs == 0)
      bs = 65536;
   uint32_t baseAddr = outFile.getFlashAddress();
   uint32_t totalLen = outFile.size();
   for (uint32_t off = 0; eraseSlot && off < totalLen; off += bs) {
      if (!waitFlashReady())
         return false;
      SerialFlash.eraseBlock(baseAddr + off);
      if (!waitFlashReady())
         return false;
   }
   outFile.seek(0);
   return true;
}

struct RawSlot
{
   uint32_t written = 0;       // bytes of the file stored so far
   uint32_t erased = 0;        // bytes from the start of the slot that are erased
   uint32_t blockSize = 65536; // erase unit of the flash
   bool overflow = false;      // the file is larger than the slot
};
RawSlot rawSlot;

static uint32_t downloadSlotSize() {
   uint8_t id[5] = {0, 0, 0, 0, 0};
   SerialFlash.readID(id);
   const uint32_t capacity = SerialFlash.capacity(id);
   uint32_t bs = SerialFlash.blockSize();
   if (bs == 0)
      bs = 65536;
   // the flash also holds the directory (first block) and the picture slot (tmp.bmp)
   const uint32_t reserved = bs + ((IMAGE_SLOT_SIZE + bs - 1) / bs) * bs;
   uint32_t size = (capacity > reserved) ? ((capacity - reserved) / bs) * bs : 0;
   if (size > MAX_DOWNLOAD_SIZE)
      size = MAX_DOWNLOAD_SIZE;
   if (size < IMAGE_SLOT_SIZE)
      size = IMAGE_SLOT_SIZE;
   return size;
}

static void rawSlotBegin() {
   rawSlot = RawSlot();
   const uint32_t bs = SerialFlash.blockSize();
   if (bs != 0)
      rawSlot.blockSize = bs;
   saveFile.seek(0);
}

// Appends bytes of the downloaded file to the slot (saveFile).
static bool rawSlotWrite(const uint8_t *data, uint32_t len) {
   if (len == 0)
      return true;
   if (len > saveFile.size() - rawSlot.written) {
      rawSlot.overflow = true;
      return false;
   }
   while (rawSlot.erased < rawSlot.written + len) {
      if (!waitFlashReady())
         return false;
      SerialFlash.eraseBlock(saveFile.getFlashAddress() + rawSlot.erased);
      if (!waitFlashReady())
         return false;
      rawSlot.erased += rawSlot.blockSize;
   }
   if (saveFile.write(data, len) != len)
      return false;
   rawSlot.written += len;
   return true;
}

bool hasValidFlashImage(const char *name = "tmp.bmp") {
   SerialFlashFile f = SerialFlash.open(name);
   uint8_t magic[2] = {0xFF, 0xFF};
   return f && f.size() >= (uint32_t)(EPD_WIDTH * EPD_HEIGHT / 2) &&
          f.read(magic, 2) == 2 && !(magic[0] == 0xFF && magic[1] == 0xFF);
}

// ---------------------------------------------------------------------------
// Image conversion
//
// Turns a downloaded picture into the display raster (IMG_WIDTH x IMG_HEIGHT,
// 4 bit per pixel, row by row) and dithers it to the display colours.
// A picture larger than the display is scaled down to fit, the aspect ratio is
// kept. A smaller picture keeps its size. The picture is centred, the rest of
// the display stays white.
// ---------------------------------------------------------------------------

struct ImageConversion
{
   int outW = 0; // size of the picture on the display
   int outH = 0;
   int offX = 0;              // left margin (the top margin is written as white rows)
   int rowsWritten = 0;       // display rows written so far
   uint8_t *rowRgb = nullptr; // one picture row: outW pixels, 3 bytes (R, G, B) each
};
ImageConversion conv;

// Writes white display rows until rowsWritten reaches untilRow.
static void convWriteWhiteRows(int untilRow) {
   uint8_t row[IMG_WIDTH / 2];
   memset(row, 0x66, sizeof(row));
   while (conv.rowsWritten < untilRow && conv.rowsWritten < IMG_HEIGHT) {
      rawOutFile.write(row, sizeof(row));
      conv.rowsWritten++;
   }
}

static void convRelease() {
   free(conv.rowRgb);
   conv.rowRgb = nullptr;
}

// Places a picture of the given size on the display and writes the white rows above it.
static bool convBegin(int pictureW, int pictureH) {
   if (pictureW <= 0 || pictureH <= 0)
      return false;

   int outW = pictureW;
   int outH = pictureH;
   if (outW > IMG_WIDTH || outH > IMG_HEIGHT) {
      // too large: scale down to fit, keep the aspect ratio
      if ((int64_t)pictureW * IMG_HEIGHT >= (int64_t)pictureH * IMG_WIDTH) {
         outW = IMG_WIDTH;
         outH = (int)((int64_t)pictureH * IMG_WIDTH / pictureW);
      }
      else {
         outH = IMG_HEIGHT;
         outW = (int)((int64_t)pictureW * IMG_HEIGHT / pictureH);
      }
      if (outW < 1)
         outW = 1;
      if (outH < 1)
         outH = 1;
   }

   convRelease();
   conv.rowRgb = (uint8_t *)malloc(outW * 3);
   if (!conv.rowRgb) {
      Serial.println("[IMAGE] OOM allocating row buffer");
      return false;
   }
   conv.outW = outW;
   conv.outH = outH;
   conv.offX = (IMG_WIDTH - outW) / 2;
   conv.rowsWritten = 0;
   memset(err_curr, 0, sizeof(err_curr));
   memset(err_next, 0, sizeof(err_next));
   Serial.printf("[IMAGE] Picture %dx%d -> %dx%d on the %dx%d display\n", pictureW, pictureH, outW, outH, IMG_WIDTH, IMG_HEIGHT);

   convWriteWhiteRows((IMG_HEIGHT - outH) / 2);
   return true;
}

// Dithers the picture row in conv.rowRgb (Floyd-Steinberg) and writes it as one display row.
// The error is only spread inside the picture, so the white margin stays clean.
static void convWriteRow() {
   if (conv.rowsWritten >= IMG_HEIGHT)
      return;

   uint8_t out_row[IMG_WIDTH / 2];
   memset(out_row, 0x66, sizeof(out_row));
   const uint8_t *rgb = conv.rowRgb;
   const int lastX = conv.outW - 1;

   for (int x = 0; x <= lastX; x++) {
      int orig_r = rgb[x * 3];
      int orig_g = rgb[x * 3 + 1];
      int orig_b = rgb[x * 3 + 2];

      // Clean white & black threshold to prevent noise from JPEG artifacts
      snapColor(orig_r, orig_g, orig_b);

      int r = orig_r + err_curr[x * 3];
      int g = orig_g + err_curr[x * 3 + 1];
      int b = orig_b + err_curr[x * 3 + 2];

      r = (r < 0) ? 0 : (r > 255) ? 255
                                  : r;
      g = (g < 0) ? 0 : (g > 255) ? 255
                                  : g;
      b = (b < 0) ? 0 : (b > 255) ? 255
                                  : b;

      uint8_t best = findClosestColor(r, g, b);
      int err_r = r - (int)((acep_palette[best] >> 16) & 0xFF);
      int err_g = g - (int)((acep_palette[best] >> 8) & 0xFF);
      int err_b = b - (int)(acep_palette[best] & 0xFF);

      if (x < lastX) {
         err_curr[(x + 1) * 3] += (err_r * 7) >> 4;
         err_curr[(x + 1) * 3 + 1] += (err_g * 7) >> 4;
         err_curr[(x + 1) * 3 + 2] += (err_b * 7) >> 4;
      }
      if (x > 0) {
         err_next[(x - 1) * 3] += (err_r * 3) >> 4;
         err_next[(x - 1) * 3 + 1] += (err_g * 3) >> 4;
         err_next[(x - 1) * 3 + 2] += (err_b * 3) >> 4;
      }
      err_next[x * 3] += (err_r * 5) >> 4;
      err_next[x * 3 + 1] += (err_g * 5) >> 4;
      err_next[x * 3 + 2] += (err_b * 5) >> 4;

      if (x < lastX) {
         err_next[(x + 1) * 3] += (err_r * 1) >> 4;
         err_next[(x + 1) * 3 + 1] += (err_g * 1) >> 4;
         err_next[(x + 1) * 3 + 2] += (err_b * 1) >> 4;
      }

      const int px = conv.offX + x;
      if (px % 2 == 0)
         out_row[px / 2] = (out_row[px / 2] & 0x0F) | (best << 4);
      else
         out_row[px / 2] = (out_row[px / 2] & 0xF0) | (best & 0x0F);
   }

   rawOutFile.write(out_row, sizeof(out_row));
   memcpy(err_curr, err_next, sizeof(err_curr));
   memset(err_next, 0, sizeof(err_next));
   conv.rowsWritten++;
}

// Writes the white rows below the picture and closes the display image.
static void convFinish() {
   convWriteWhiteRows(IMG_HEIGHT);
   convRelease();
   waitFlashReady();
   rawOutFile.close();
}

// --- JPEG ---

// The decoder delivers the picture in strips of one MCU row (up to 16 pixel rows). A strip is
// kept already scaled to conv.outW pixels per row, so its size does not depend on the JPEG.
uint16_t *jpgStrip = nullptr; // RGB565
int jpgStripRows = 0;         // rows the strip buffer holds
int jpgStripY = 0;            // decoded row of the first strip row
int jpgStripH = 0;            // strip rows in use
int jpgDecW = 0;              // size the decoder delivers (after its own 1/2, 1/4 or 1/8 scaling)
int jpgDecH = 0;
int jpgNextRow = 0; // next picture row to write

void jpgFlushStrip() {
   for (int y = 0; y < jpgStripH; y++) {
      const int decY = jpgStripY + y;
      // every picture row that takes its pixels from this decoded row
      while (jpgNextRow < conv.outH && (int)((int64_t)jpgNextRow * jpgDecH / conv.outH) <= decY) {
         const uint16_t *src = jpgStrip + y * conv.outW;
         uint8_t *dst = conv.rowRgb;
         for (int x = 0; x < conv.outW; x++) {
            const uint16_t c = src[x];
            *dst++ = (c & 0xF800) >> 8;
            *dst++ = (c & 0x07E0) >> 3;
            *dst++ = (c & 0x001F) << 3;
         }
         convWriteRow();
         jpgNextRow++;
      }
   }
   jpgStripH = 0;
}

int JPEGDraw(JPEGDRAW *pDraw) {
   if (pDraw->y != jpgStripY && jpgStripH > 0) {
      jpgFlushStrip();
   }
   jpgStripY = pDraw->y;

   const int x0 = pDraw->x;
   int w = pDraw->iWidthUsed;
   if (x0 + w > jpgDecW)
      w = jpgDecW - x0;
   const int h = (pDraw->iHeight < jpgStripRows) ? pDraw->iHeight : jpgStripRows;
   if (x0 < 0 || w <= 0 || h <= 0)
      return 1;
   jpgStripH = h;

   // picture columns that take their pixel from this block (decoded columns x0 .. x0 + w - 1)
   int ox = (int)(((int64_t)x0 * conv.outW + jpgDecW - 1) / jpgDecW);
   for (; ox < conv.outW; ox++) {
      const int sx = (int)((int64_t)ox * jpgDecW / conv.outW);
      if (sx >= x0 + w)
         break;
      if (sx < x0)
         continue;
      const uint16_t *src = pDraw->pPixels + (sx - x0);
      uint16_t *dst = jpgStrip + ox;
      for (int y = 0; y < h; y++) {
         dst[y * conv.outW] = src[y * pDraw->iWidth];
      }
   }
   return 1;
}

static bool convertJpeg(const char *rawFileName, const char *outFileName) {
   if (!prepareFlashSlot(outFileName, IMAGE_SLOT_SIZE, rawOutFile))
      return false;
   if (!jpeg.open(rawFileName, myOpen, myClose, myRead, mySeek, JPEGDraw)) {
      Serial.printf("[IMAGE] JPEG not readable (decoder error %d)\n", jpeg.getLastError());
      discardFlashSlot(rawOutFile);
      return false;
   }

   const int w = jpeg.getWidth();
   const int h = jpeg.getHeight();
   bool ok = convBegin(w, h);
   int shift = 0; // the decoder can deliver 1/2, 1/4 or 1/8 of the size

   if (ok) {
      if (jpeg.getJPEGType() == JPEG_MODE_PROGRESSIVE) {
         // JPEGDEC only decodes the first scan of a progressive JPEG: 1/8 of the resolution
         Serial.println("[IMAGE] Progressive JPEG: decoded at 1/8 resolution, use a baseline JPEG for full quality");
         shift = 3;
      }
      else {
         // as small as possible, but not smaller than the picture on the display
         while (shift < 3 && (w >> (shift + 1)) >= conv.outW && (h >> (shift + 1)) >= conv.outH) {
            shift++;
         }
      }
      jpgDecW = (w + (1 << shift) - 1) >> shift;
      jpgDecH = (h + (1 << shift) - 1) >> shift;
      // an MCU row is 16 pixel rows high if the colour is subsampled vertically, otherwise 8
      const int mcuRows = ((jpeg.getSubSample() & 0x0F) == 2) ? 16 : 8;
      jpgStripRows = mcuRows >> shift;
      jpgStrip = (uint16_t *)malloc((size_t)jpgStripRows * conv.outW * sizeof(uint16_t));
      if (!jpgStrip) {
         Serial.println("[IMAGE] OOM allocating JPEG strip buffer");
         ok = false;
      }
   }

   if (ok) {
      static const int scaleOptions[4] = {0, JPEG_SCALE_HALF, JPEG_SCALE_QUARTER, JPEG_SCALE_EIGHTH};
      jpgStripY = 0;
      jpgStripH = 0;
      jpgNextRow = 0;
      ok = (jpeg.decode(0, 0, scaleOptions[shift]) == 1);
      if (ok)
         jpgFlushStrip();
      else
         Serial.printf("[IMAGE] JPEG decoding failed (decoder error %d)\n", jpeg.getLastError());
   }

   jpeg.close();
   free(jpgStrip);
   jpgStrip = nullptr;

   if (!ok) {
      convRelease();
      discardFlashSlot(rawOutFile);
      return false;
   }
   convFinish();
   return true;
}

// --- BMP and raw display images ---

// Copies a file that already is a display image (pre-dithered BMP of the display size, raw payload).
static bool copyDisplayImage(SerialFlashFile &inFile, const char *outFileName) {
   if (!prepareFlashSlot(outFileName, IMAGE_SLOT_SIZE, rawOutFile))
      return false;
   inFile.seek(0);
   uint8_t buf[2048];

   uint32_t remaining = (lastDownloadedBytes > 0 && lastDownloadedBytes <= inFile.size()) ? lastDownloadedBytes : inFile.size();
   if (remaining > IMAGE_SLOT_SIZE)
      remaining = IMAGE_SLOT_SIZE;
   while (remaining > 0) {
      const uint32_t bytesRead = inFile.read(buf, (remaining < sizeof(buf)) ? remaining : sizeof(buf));
      if (bytesRead == 0)
         break;
      rawOutFile.write(buf, bytesRead);
      remaining -= bytesRead;
   }
   waitFlashReady();
   rawOutFile.close();
   return true;
}

static uint16_t readLe16(const uint8_t *p) {
   return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t readLe32(const uint8_t *p) {
   return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// Uncompressed BMP with 4, 24 or 32 bit per pixel, any size, stored top-down or bottom-up.
static bool convertBmp(SerialFlashFile &inFile, const char *outFileName) {
   uint8_t header[54];
   inFile.seek(0);
   if (inFile.read(header, sizeof(header)) != sizeof(header))
      return false;

   const uint32_t pixelOffset = readLe32(header + 10);
   const uint32_t dibSize = readLe32(header + 14);
   const int32_t width = (int32_t)readLe32(header + 18);
   const int32_t rawHeight = (int32_t)readLe32(header + 22);
   const uint16_t bpp = readLe16(header + 28);
   const uint32_t compression = readLe32(header + 30);
   const uint32_t colorsUsed = readLe32(header + 46);
   const bool topDown = rawHeight < 0;
   const int32_t height = topDown ? -rawHeight : rawHeight;

   const bool formatOk = (bpp == 4 || bpp == 24 || bpp == 32) && (compression == 0 || (compression == 3 && bpp == 32));
   if (dibSize < 40 || !formatOk || width <= 0 || height <= 0 || width > 16384 || height > 16384) {
      Serial.printf("[IMAGE] Unsupported BMP (%ldx%ld, %u bit, compression %lu)\n", (long)width, (long)rawHeight, bpp, (unsigned long)compression);
      return false;
   }

   const uint32_t stride = (((uint32_t)width * bpp + 31) / 32) * 4; // rows are padded to 4 bytes
   const uint32_t fileLen = (lastDownloadedBytes > 0 && lastDownloadedBytes <= inFile.size()) ? lastDownloadedBytes : inFile.size();
   if ((uint64_t)pixelOffset + (uint64_t)stride * height > fileLen) {
      Serial.println("[IMAGE] BMP is incomplete");
      return false;
   }

   if (bpp == 4 && topDown && width == IMG_WIDTH && height == IMG_HEIGHT) {
      Serial.println("[IMAGE] 4-bit BMP detected. Already dithered.");
      return copyDisplayImage(inFile, outFileName);
   }

   Serial.printf("[IMAGE] %u-bit BMP detected. Dithering...\n", bpp);

   // colour table of a 4-bit BMP (blue, green, red, reserved)
   uint8_t palette[16][3];
   memset(palette, 0, sizeof(palette));
   if (bpp == 4) {
      const uint32_t colors = (colorsUsed > 0 && colorsUsed < 16) ? colorsUsed : 16;
      uint8_t entry[4];
      inFile.seek(14 + dibSize);
      for (uint32_t i = 0; i < colors; i++) {
         if (inFile.read(entry, 4) != 4)
            return false;
         palette[i][0] = entry[2];
         palette[i][1] = entry[1];
         palette[i][2] = entry[0];
      }
   }

   uint8_t *srcRow = (uint8_t *)malloc(stride);
   if (!srcRow) {
      Serial.println("[IMAGE] OOM allocating BMP row buffer");
      return false;
   }
   if (!prepareFlashSlot(outFileName, IMAGE_SLOT_SIZE, rawOutFile)) {
      free(srcRow);
      return false;
   }
   if (!convBegin(width, height)) {
      free(srcRow);
      discardFlashSlot(rawOutFile);
      return false;
   }

   const int bytesPerPixel = bpp / 8;
   bool ok = true;
   for (int oy = 0; oy < conv.outH && ok; oy++) {
      const int sy = (int)((int64_t)oy * height / conv.outH);
      const uint32_t fileRow = topDown ? (uint32_t)sy : (uint32_t)(height - 1 - sy);
      inFile.seek(pixelOffset + fileRow * stride);
      if (inFile.read(srcRow, stride) != stride) {
         ok = false;
         break;
      }

      uint8_t *dst = conv.rowRgb;
      for (int ox = 0; ox < conv.outW; ox++) {
         const int sx = (int)((int64_t)ox * width / conv.outW);
         if (bpp == 4) {
            const uint8_t index = (sx % 2 == 0) ? (srcRow[sx / 2] >> 4) : (srcRow[sx / 2] & 0x0F);
            *dst++ = palette[index][0];
            *dst++ = palette[index][1];
            *dst++ = palette[index][2];
         }
         else {
            const uint8_t *p = srcRow + sx * bytesPerPixel; // blue, green, red
            *dst++ = p[2];
            *dst++ = p[1];
            *dst++ = p[0];
         }
      }
      convWriteRow();
   }
   free(srcRow);

   if (!ok) {
      convRelease();
      discardFlashSlot(rawOutFile);
      return false;
   }
   convFinish();
   return true;
}

bool processImageFile(const char *rawFileName, const char *outFileName) {
   SerialFlashFile inFile = SerialFlash.open(rawFileName);
   if (!inFile)
      return false;
   uint8_t magic[2] = {0, 0};
   inFile.read(magic, 2);
   Serial.printf("[IMAGE] Read magic: 0x%02X 0x%02X from file '%s'\n", magic[0], magic[1], rawFileName);

   bool ok = false;
   if (magic[0] == 0xFF && magic[1] == 0xD8) {
      Serial.println("[IMAGE] JPEG detected. Dithering on-device...");
      inFile.close(); // the decoder opens the file itself
      return convertJpeg(rawFileName, outFileName);
   }
   else if (magic[0] == 'B' && magic[1] == 'M') {
      ok = convertBmp(inFile, outFileName);
   }
   else if (magic[0] == 0x66 && magic[1] == 0x66) {
      Serial.println("[IMAGE] Raw dithered payload detected.");
      ok = copyDisplayImage(inFile, outFileName);
   }

   inFile.close();
   return ok;
}

// Power supply display
#ifdef EPD_TYPE_13INCH
bool powerSupplyDisplay(bool enable) {
   bool tempState = systemData.displayPowerOn;
   if (enable) {
      pinMode(DISP_POWER, OUTPUT);
      digitalWrite(DISP_POWER, HIGH);
      systemData.displayPowerOn = true;
   }
   else {
      pinMode(DISP_POWER, INPUT);
      digitalWrite(DISP_POWER, LOW);
      systemData.displayPowerOn = false;
   }
   if (tempState != systemData.displayPowerOn) {
      if (enable) {
         Serial.printf("[POWER] Supply ON\n");
         delay(100);
         sdInit();
      }
      return true;
   }
   else {
      return false;
   }
}
#else
bool powerSupplyDisplay(bool enable) {
   return true;
}
#endif

void WiFiEvent(WiFiEvent_t event) {
   switch (event) {
   case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      if (DEBUG_FLAG)
         Serial.println("[NETWORK] WiFi connected");
      Serial.printf("[NETWORK] IP address: ");
      Serial.println(WiFi.localIP());

      if (wifiSettings.wifiIsConnected != true) {
         wifiSettings.wifiIsConnected = true;
         if (wifiSettings.bleInitOk) {
            uint8_t val = 1;
            wifiConnectedCharacteristic->setValue(&val, 1);
            wifiConnectedCharacteristic->notify();

            if (wifiInfoCharacteristic) {
               JsonDocument doc;
               doc["ip"] = WiFi.localIP().toString();
               doc["rssi"] = WiFi.RSSI();
               doc["ssid"] = WiFi.SSID(); // shown by the web UI next to the IP address
               String json;
               serializeJson(doc, json);
               wifiInfoCharacteristic->setValue(json.c_str());
               wifiInfoCharacteristic->notify();
            }
         }
      }

      break;
   case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("[NETWORK] WiFi lost connection");
      wifiSettings.wifiOnboardingFailed = true;
      if (wifiSettings.wifiIsConnected != false) {
         wifiSettings.wifiIsConnected = false;
         if (wifiSettings.bleInitOk) {
            uint8_t val = 0;
            wifiConnectedCharacteristic->setValue(&val, 1);
            wifiConnectedCharacteristic->notify();

            if (wifiInfoCharacteristic) {
               wifiInfoCharacteristic->setValue("{}");
               wifiInfoCharacteristic->notify();
            }
         }
      }
      break;
   default:
      break;
   }
}

// Restarts into the download mode of the ROM, as if the boot button was held during a reset.
void rebootIntoRomBootloader() {
   Serial.println("[SYSTEM] Rebooting into ROM Download Bootloader...");
   Serial.flush();
   delay(100);
#ifdef LP_AON_SYS_CFG_REG
   REG_WRITE(LP_AON_SYS_CFG_REG, REG_READ(LP_AON_SYS_CFG_REG) | LP_AON_FORCE_DOWNLOAD_BOOT);
#endif
   esp_restart();
}

void checkSerialBootloaderCommand() {
   while (Serial.available()) {
      const int received = Serial.read();
      if ((received == 'B' || received == 'b') && systemData.usbConnected) {
         Serial.println("[MAIN] Bootloader command 'B' received via Serial!");
         rebootIntoRomBootloader();
      }
   }
}

void timeoutFailsafe(int time) {
   Serial.println("[MAIN] Timeout Failsafe");

   gotToDeepSleep(DEFAULT_SLEEP, true, false);
}

void ledBlinkFunctionOff() {
   analogWrite(LED_PIN, 0);
   perdiodicLedOff.detach();
}

void ledBlinkFunction() {
   analogWrite(LED_PIN, systemData.ledDimValue);
   perdiodicLedOff.attach_ms(periodicLedTimeout * 0.2, ledBlinkFunctionOff);
}

// set blink with timeout in ms
void ledBlink(int timeout, bool on, int dimValue) {
   pinMode(LED_PIN, OUTPUT);
   if (dimValue > 100)
      dimValue = 100;
   if (dimValue < 0)
      dimValue = 0;
   systemData.ledDimValue = (dimValue * 255) / 100;
   if (DEBUG_FLAG)
      Serial.printf("[LED] Set DIM: %d Set Time: %d On: %d (dimInput:%d)\n", systemData.ledDimValue, timeout, on, dimValue);

   if (on) {
      if (timeout <= 0) {
         perdiodicLed.detach();
         perdiodicLedOff.detach();
         analogWrite(LED_PIN, systemData.ledDimValue); // Dim brightness (0-255)
         return;
      }
      periodicLedIsOn = true;
      periodicLedTimeout = timeout * 2;
      perdiodicLed.attach_ms(periodicLedTimeout, ledBlinkFunction);
   }
   else {
      perdiodicLed.detach();
      perdiodicLedOff.detach();
      analogWrite(LED_PIN, 0);
      delay(periodicLedTimeout * 0.3);
      analogWrite(LED_PIN, 0);
      periodicLedIsOn = false;
   }
}

int readVDD(bool singleReading) {
   pinMode(BAT_VOLT_EN_PIN, OUTPUT);
#ifdef EPD_TYPE_13INCH
   digitalWrite(BAT_VOLT_EN_PIN, HIGH);
#else
   digitalWrite(BAT_VOLT_EN_PIN, LOW);
#endif
   delay(3);
   int retries = 1;
   if (!singleReading) {
      retries = 5;
   }
   float rawValue = 0;
   int count = 0;
   for (size_t i = 0; i < retries; i++) {
      float readValue = analogRead(BAT_VOLT_SENSE_PIN);
      delayMicroseconds(18000);
      rawValue += readValue;
      count++;
   }
   if (count > 0) {
      rawValue = rawValue / count;
   }
   pinMode(BAT_VOLT_EN_PIN, INPUT);
   int vdd = int(round(rawValue * VDD_CORRECTION_FACTOR));
   Serial.printf("[BAT] ADC Raw: %.1f -> VDD: %d mV\n", rawValue, vdd);
   return vdd;
}

bool EepromInit(int size) {
   if (!EEPROM.begin(size)) { // Init EEPROM
      Serial.println("[MEM] failed to init EEPROM");
      delay(1000);
      return false;
   }
   else {
      Serial.println("[MEM] EEPROM init OK");
      return true;
   }
}

bool EepromClear() {
   char resetValue = 0;
   for (int i = 0; i < EEPROM_SIZE; i++) {
      EEPROM.write(i, resetValue);
   }
   Serial.println("[MEM] EEPROM clear OK");
   return true;
}

// Stores a string of at most maxLen characters plus terminator, so a long
// value can never run into the neighbouring EEPROM field.
void writeStringToFlash(const char *toStore, int startAddr, int maxLen, bool commit) {
   int len = strlen(toStore);
   if (len > maxLen) {
      Serial.printf("[MEM] WARNING: String at EEPROM %d truncated (%d > %d)\n", startAddr, len, maxLen);
      len = maxLen;
   }
   for (int i = 0; i < len; i++) {
      EEPROM.write(startAddr + i, toStore[i]);
   }
   EEPROM.write(startAddr + len, '\0');
   if (commit)
      EEPROM.commit();
}

String readStringFromFlash(int startAddr) {
   char in[129];
   int i = 0;
   for (; i < 128; i++) {
      char c = EEPROM.read(startAddr + i);
      if (c == '\0' || c == (char)0xFF) {
         break;
      }
      in[i] = c;
   }
   in[i] = '\0';

   return String(in);
}

int readIntFromFlash(int addr) {
   DataLayout data3;
   EEPROM.get(addr, data3);
   return data3.integer;
}

// The charger must never run unless the user switched "Charger Mode" on (normal batteries must
// not be charged). So only a clean 1 in an initialised memory counts as on; an empty, older or
// damaged memory means off.
bool storedChargerMode() {
   return EEPROM.read(499) == 42 && readIntFromFlash(EEPROM_SETTINGS_ADR + 550) == 1;
}

// Writes exactly the 4 bytes of the value. (Writing the whole 8 byte DataLayout
// put 4 uninitialised bytes into the field that follows 5 bytes later.)
void writeIntToFlash(int value, int startAddr, bool commit) {
   EEPROM.put(startAddr, value);
   if (commit)
      EEPROM.commit();
}

void saveSettingsToFlash(int startAddr) {
   // All fields go to flash in one commit, so a power cut (or a press of the reset
   // button) while saving leaves either the old or the new settings, never a mix.
   const int maxLen = MAX_SETTING_STRING_LEN;
   writeIntToFlash(settings.showBatteryWarning, startAddr + 5, false);
   writeIntToFlash(settings.showWifiWarning, startAddr + 10, false);
   writeIntToFlash(settings.sleepDisabled, startAddr + 15, false);
   writeIntToFlash(settings.imageMode, startAddr + 20, false);
   writeStringToFlash(settings.downloadUrl.c_str(), startAddr + 25, maxLen, false);
   writeStringToFlash(settings.lastModified.c_str(), startAddr + 155, maxLen, false);
   writeStringToFlash(settings.httpAuthUser.c_str(), startAddr + 285, maxLen, false);
   writeStringToFlash(settings.httpAuthPassword.c_str(), startAddr + 415, maxLen, false);
   writeIntToFlash(settings.motionWakeup, startAddr + 545, false);
   writeIntToFlash(settings.chargerMode, startAddr + 550, false);
   writeStringToFlash(settings.settingsUrl.c_str(), startAddr + 555, maxLen, false);
   writeStringToFlash(settings.settingsLastModified.c_str(), startAddr + 685, maxLen, false);
   writeIntToFlash(settings.autoRotation, startAddr + 815, false);
   EEPROM.commit();
   Serial.println("[MEM] Settings saved to EEPROM");
}

void restoreSettingsToFlash(int startAddr) {
   wifiSettings.ssid = readStringFromFlash(0);
   wifiSettings.pss = readStringFromFlash(40);
   settings.timeout = storeSleepTimeMem(0);
   settings.showBatteryWarning = readIntFromFlash(startAddr + 5);
   settings.showWifiWarning = readIntFromFlash(startAddr + 10);
   settings.sleepDisabled = readIntFromFlash(startAddr + 15);
   settings.imageMode = readIntFromFlash(startAddr + 20);
   settings.downloadUrl = readStringFromFlash(startAddr + 25);
   settings.lastModified = readStringFromFlash(startAddr + 155);
   settings.httpAuthUser = readStringFromFlash(startAddr + 285);
   settings.httpAuthPassword = readStringFromFlash(startAddr + 415);
   settings.motionWakeup = readIntFromFlash(startAddr + 545);
   settings.chargerMode = storedChargerMode();
   settings.settingsUrl = readStringFromFlash(startAddr + 555);
   settings.settingsLastModified = readStringFromFlash(startAddr + 685);
   int autoRot = readIntFromFlash(startAddr + 815);
   settings.autoRotation = (autoRot == 0) ? false : true;
   Serial.println("[MEM] Settings restored from EEPROM");
   if (DEBUG_FLAG) {
      Serial.printf("[MEM] Settings - BatteryWarning: %d WifiWarning: %d SleepDisabled: %d ImageMode: %d MotionWakeup: %d ChargerMode: %d\n", settings.showBatteryWarning, settings.showWifiWarning, settings.sleepDisabled, settings.imageMode, settings.motionWakeup, settings.chargerMode);
   }
}

// Device status for the server, sent with every request to the image and settings URL.
// The values are the ones taken at wake-up (battery voltage before WiFi was switched on).
void addTelemetryHeaders(HTTPClient &http) {
   http.addHeader("X-OpenPaper-Battery-Millivolts", String(systemData.vddValue));
   http.addHeader("X-OpenPaper-USB-Connected", systemData.usbConnected ? "1" : "0");
   http.addHeader("X-OpenPaper-Charging", systemData.charging ? "1" : "0");
   http.addHeader("X-OpenPaper-Firmware-Version", SOFTWARE_VERSION);
#ifdef EPD_TYPE_13INCH
   http.addHeader("X-OpenPaper-Display", "epd13");
#else
   http.addHeader("X-OpenPaper-Display", "epd7");
#endif
   const char *wakeup = "reset";
   if (systemData.wakeupCause == wakeup_reason_t::BUTTON)
      wakeup = "button";
   else if (systemData.wakeupCause == wakeup_reason_t::MOTION)
      wakeup = "motion";
   else if (systemData.wakeupCause == wakeup_reason_t::TIMER)
      wakeup = "timer";
   http.addHeader("X-OpenPaper-Wakeup", wakeup);
   http.addHeader("X-OpenPaper-WiFi-RSSI", String(WiFi.RSSI()));
   if (systemData.deviceOrientation >= 0) // -1: the sensor gave no valid reading
      http.addHeader("X-OpenPaper-Orientation", String(systemData.deviceOrientation));
}

// "https://nas.local:8080/dir/file" -> "https://nas.local:8080"
static String urlOrigin(const String &url) {
   const int schemeEnd = url.indexOf("://");
   if (schemeEnd < 0)
      return "";
   int end = url.length();
   for (const char *stop = "/?#"; *stop; stop++) {
      const int i = url.indexOf(*stop, schemeEnd + 3);
      if (i >= 0 && i < end)
         end = i;
   }
   String origin = url.substring(0, end);
   origin.toLowerCase();
   return origin;
}

// sendAuth: send the HTTP login of the picture download with the request
String getRedirect(String url, bool sendAuth = true) {
   // Redirects within one protocol are followed by the download itself. Only the change from
   // http:// to https:// needs this extra request.
   if (!url.startsWith("http://"))
      return url;
   WiFiClientSecure secureClient;
   secureClient.setInsecure();
   HTTPClient http;
   http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
   if (url.indexOf("https:") >= 0) {
      http.begin(secureClient, url);
   }
   else {
      http.begin(url);
   }

   if (sendAuth && settings.httpAuthUser.length() > 0) {
      http.setAuthorization(settings.httpAuthUser.c_str(), settings.httpAuthPassword.c_str());
   }

   const char *headerkeys[] = {"Location"};
   size_t headerkeyssize = sizeof(headerkeys) / sizeof(char *);
   http.collectHeaders(headerkeys, headerkeyssize);
   addTelemetryHeaders(http);
   int httpCode = http.GET();

   if (httpCode > 0) {
      if (httpCode == HTTP_CODE_MOVED_PERMANENTLY) {
         String urlNew = http.header("Location").c_str();
         Serial.println("[NETWORK] Redirect with 301");
         http.end();
         return urlNew;
      }
   }
   return url;
}

// loadImageFromWeb removed from here since it's defined later

uint16_t getBleMaxChunkPayload(NimBLEConnInfo &connInfo) {
   uint16_t mtu = pServer ? pServer->getPeerMTU(connInfo.getConnHandle()) : blePeerMtu;
   if (mtu < 23)
      mtu = blePeerMtu;
   if (mtu < 23)
      mtu = 247;
   uint16_t maxAtt = (mtu - 3 > 512) ? 512 : (mtu - 3);
   uint16_t payload = (maxAtt > 496 + 4) ? 496 : ((maxAtt > 4) ? ((maxAtt - 4) & ~1) : 20);
   return payload;
}

class ServerCallbacks : public NimBLEServerCallbacks
{
   void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
      Serial.printf("\n[BLE]Client address: %s\n", connInfo.getAddress().toString().c_str());
      pServer->updateConnParams(connInfo.getConnHandle(), 6, 12, 0, 400);
      uint16_t peerMtu = pServer->getPeerMTU(connInfo.getConnHandle());
      if (peerMtu >= 23)
         blePeerMtu = peerMtu;
      bleLastActivity = millis();
      isBleClientConnected = true;
      if (wifiSettings.bleInitOk) {
         Serial.printf("[BLE] restart advertising...\n[");
         NimBLEDevice::startAdvertising();
      }
   }
   void onDisconnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo, int reason) override {
      Serial.printf("\n[BLE] Client disconnected");
      isBleClientConnected = false;
      lastDisconnectTime = millis();
      if (bleFile) {
         Serial.println("\n[BLE] Upload interrupted by disconnect; discarding slot.");
         discardFlashSlot(bleFile);
      }
      if (fwUpdateInProgress) {
         Update.abort();
         fwUpdateInProgress = false;
      }
      if (bleWriteBuffer != nullptr) {
         free(bleWriteBuffer);
         bleWriteBuffer = nullptr;
      }
      bleWriteBufferPos = 0;
      bleExpectedSeq = 0;
      bleExpectedFwBytes = 0;
      bleSeqError = false;
      bleUploadError = false;
      bleDisplayBusy = false;
      bleProtocolV2 = false;
      if (wifiSettings.bleInitOk) {
         Serial.printf("\n[BLE] restart advertising...\n[");
         NimBLEDevice::startAdvertising();
      }
   };
   void onMTUChange(uint16_t MTU, NimBLEConnInfo &connInfo) override {
      blePeerMtu = MTU;
      Serial.printf("\n[BLE] MTU updated: %u for connection ID: %u\n", MTU, connInfo.getConnHandle());
   }

} serverCallbacks;

// Rejects BLE string values that would not fit into their EEPROM slot.
static bool bleValueFits(const NimBLEAttValue &val, size_t maxLen, const char *name) {
   if (val.length() <= maxLen)
      return true;
   Serial.printf("[BLE] ERROR: %s too long (%u > %u), ignored.\n", name, (unsigned)val.length(), (unsigned)maxLen);
   return false;
}

class CharacteristicCallbacks : public NimBLECharacteristicCallbacks
{
   void onRead(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override {
      bleLastActivity = millis();
      std::string uuidStr = pCharacteristic->getUUID().toString();
      if (uuidStr == "10000004-0000-0000-0000-000000000001") {
         uint16_t currentPos = bleWriteBufferPos;
         uint16_t statusPos = bleDisplayBusy ? 0xFFFD : (bleUploadError ? 0xFFFF : (bleSeqError ? 0xFFFE : currentPos));
         uint32_t respCrc = 0;
         if (!bleUploadError && !bleSeqError) {
            if (bleWriteBuffer != nullptr && currentPos > 0) {
               respCrc = calcCRC32(bleWriteBuffer, currentPos);
            }
            else if (!bleFile && !fwUpdateInProgress) {
               respCrc = bleFinalFlashCrc;
            }
         }
         uint16_t maxPayload = getBleMaxChunkPayload(connInfo);
         uint8_t resp[8];
         resp[0] = statusPos & 0xFF;
         resp[1] = (statusPos >> 8) & 0xFF;
         resp[2] = respCrc & 0xFF;
         resp[3] = (respCrc >> 8) & 0xFF;
         resp[4] = (respCrc >> 16) & 0xFF;
         resp[5] = (respCrc >> 24) & 0xFF;
         resp[6] = maxPayload & 0xFF;
         resp[7] = (maxPayload >> 8) & 0xFF;
         pCharacteristic->setValue(resp, 8);
         return;
      }
      NimBLEAttValue attrVal = pCharacteristic->getValue();
      Serial.printf("%s : onRead(), value: %s\n",
                    uuidStr.c_str(),
                    attrVal.c_str());
   };

   void onWrite(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override {
      bleLastActivity = millis();
      std::string uuidStr = pCharacteristic->getUUID().toString();
      NimBLEAttValue attrVal = pCharacteristic->getValue();
      const uint8_t *pData = attrVal.data();
      size_t dataLen = attrVal.length();

      // Serial.printf("%s : onWrite(), value len: %d\n", uuidStr.c_str(), dataLen);

      // Für String-Werte eine sichere Konvertierung mit dem richtigen c_str()
      if (uuidStr == "a62eed84-7b0d-11ed-a1eb-0242ac120002") {
         if (!bleValueFits(attrVal, MAX_WIFI_PASS_LEN, "WiFi password"))
            return;
         wifiSettings.pss = attrVal.c_str();
         pCharacteristic->setValue(""); // do not keep the password in the GATT table
         Serial.printf("[BLE] Set wifi PASS (%u chars)\n", (unsigned)wifiSettings.pss.length());
         wifiSettings.isDeployWifi = true;
      }
      else if (uuidStr == "090b0ef2-7b0d-11ed-a1eb-0242ac120002") {
         if (!bleValueFits(attrVal, MAX_WIFI_SSID_LEN, "WiFi SSID"))
            return;
         wifiSettings.ssid = attrVal.c_str();
         Serial.printf("[BLE] Set wifi SSID: %s\n", wifiSettings.ssid.c_str());
      }
      else if (uuidStr == "10000001-0000-0000-0000-000000000001") {
         if (!bleValueFits(attrVal, MAX_SETTING_STRING_LEN, "Download URL"))
            return;
         settings.downloadUrl = attrVal.c_str();
         settings.lastModified = ""; // Reset lastModified um Download zu erzwingen
         Serial.printf("[BLE] Set URL: %s\n", settings.downloadUrl.c_str());
         if (settings.downloadUrl.length() > 0) {
            settings.imageMode = 1;
         }
      }
      else if (uuidStr == "10000007-0000-0000-0000-000000000001") {
         if (!bleValueFits(attrVal, MAX_SETTING_STRING_LEN, "HTTP user"))
            return;
         settings.httpAuthUser = attrVal.c_str();
         Serial.printf("[BLE] Set HTTP Auth user: %s\n", settings.httpAuthUser.c_str());
      }
      else if (uuidStr == "10000008-0000-0000-0000-000000000001") {
         if (!bleValueFits(attrVal, MAX_SETTING_STRING_LEN, "HTTP password"))
            return;
         settings.httpAuthPassword = attrVal.c_str();
         pCharacteristic->setValue("");
         Serial.println("[BLE] Set HTTP Auth password");
      }
      else if (uuidStr == "10000002-0000-0000-0000-000000000001") {
         int newMode = atoi(attrVal.c_str());
         if (newMode != 0 && newMode != 1) {
            Serial.printf("[BLE] ERROR: Invalid Image Mode %d, ignored.\n", newMode);
            return;
         }
         settings.imageMode = newMode;
         Serial.printf("[BLE] Set Image Mode: %d\n", settings.imageMode);
      }
      else if (uuidStr == "10000005-0000-0000-0000-000000000001") {
         long newTimeout = strtol(attrVal.c_str(), nullptr, 10);
         if (newTimeout < MIN_SLEEP_TIMEOUT || newTimeout > MAX_SLEEP_TIMEOUT) {
            Serial.printf("[BLE] ERROR: Timeout %ld out of range (%d-%d), ignored.\n", newTimeout, MIN_SLEEP_TIMEOUT, MAX_SLEEP_TIMEOUT);
            return;
         }
         settings.timeout = (int)newTimeout;
         Serial.printf("[BLE] Set Timeout/Sleep: %d\n", settings.timeout);
      }
      else if (uuidStr == "10000006-0000-0000-0000-000000000001") {
         String strVal = attrVal.c_str();
      }
      else if (uuidStr == "1000000a-0000-0000-0000-000000000001") {
         String val = attrVal.c_str();
         settings.chargerMode = (val == "1" || val == "true");
         Serial.printf("[BLE] Charger Mode updated to: %d\n", settings.chargerMode);
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
         chargeMode(settings.chargerMode);
      }
      else if (uuidStr == "1000000c-0000-0000-0000-000000000001") {
         String val = attrVal.c_str();
         settings.autoRotation = (val == "1" || val == "true");
         Serial.printf("[BLE] Auto Rotation updated to: %d\n", settings.autoRotation);
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "1000000b-0000-0000-0000-000000000001") {
         if (!bleValueFits(attrVal, MAX_SETTING_STRING_LEN, "Settings URL"))
            return;
         settings.settingsUrl = attrVal.c_str();
         Serial.printf("[BLE] Set Settings URL: %s\n", settings.settingsUrl.c_str());
         settings.settingsLastModified = ""; // Reset cache on new URL
      }
      else if (uuidStr == "10000009-0000-0000-0000-000000000001") {
         String strVal = attrVal.c_str();
         settings.motionWakeup = (strVal == "1" || strVal == "true");
         Serial.printf("[BLE] Set Motion Wakeup: %d\n", settings.motionWakeup);
      }
      else if (uuidStr == "10000004-0000-0000-0000-000000000001") {
         String cmd = attrVal.c_str();
         Serial.printf("[BLE] Upload CMD: %s\n", cmd.c_str());
         if (cmd == "SCAN_WIFI") {
            wifiScanRequested = true;
            Serial.println("[BLE] WiFi Scan requested via BLE.");
         }
         else if (cmd == "EXIT_SETUP") {
            Serial.println("[BLE] EXIT_SETUP received. Forcing exit...");
            forceExitSetup = true;
         }
         else if (cmd == "V2") {
            bleProtocolV2 = true;
            Serial.println("[BLE] Protocol V2 negotiated.");
         }
         else if (cmd == "START") {
            // The display is being refreshed from the picture slot: it must not be erased now.
            if (applyPending || applyInProgress) {
               Serial.println("[BLE] Upload START refused: display refresh in progress.");
               bleDisplayBusy = true;
               return;
            }
            bleDisplayBusy = false;
            if (fwUpdateInProgress) {
               Update.abort();
               fwUpdateInProgress = false;
            }
            if (bleFile) {
               bleFile.close();
               bleFile = SerialFlashFile();
            }
            bleUploadError = false;
            bleSeqError = false;
            bleExpectedSeq = 0;
            bleExpectedFwBytes = 0;
            bleBytesReceived = 0;
            bleWriteBufferPos = 0;
            bleRunningCrc = 0;
            bleFinalFlashCrc = 0;
            bleProtocolV2 = false;

            if (bleWriteBuffer == nullptr) {
               bleWriteBuffer = (uint8_t *)malloc(BLE_BUFFER_SIZE);
            }
            if (bleWriteBuffer == nullptr) {
               Serial.println("[BLE] ERROR: Failed to allocate memory for image buffer!");
               bleUploadError = true;
               return;
            }
            if (!prepareFlashSlot("tmp.bmp", IMAGE_SLOT_SIZE, bleFile)) {
               free(bleWriteBuffer);
               bleWriteBuffer = nullptr;
               bleUploadError = true;
               return;
            }
            Serial.println("[BLE] Upload STARTED.");
         }
         else if (cmd == "FLUSH") {
            if (bleSeqError || bleUploadError) {
               Serial.println("[BLE] ERROR: FLUSH rejected due to prior sequence/upload error!");
               bleUploadError = true;
               return;
            }
            if (fwUpdateInProgress && bleWriteBufferPos > 0) {
               if (bleBytesReceived == 0 && bleWriteBuffer[0] != 0xE9) {
                  Serial.printf("[BLE] ERROR: Invalid ESP32 firmware magic byte 0x%02X!\n", bleWriteBuffer[0]);
                  Update.abort();
                  fwUpdateInProgress = false;
                  bleUploadError = true;
                  return;
               }
               if (bleExpectedFwBytes > 0 && (bleBytesReceived + bleWriteBufferPos) > bleExpectedFwBytes) {
                  Serial.println("[BLE] ERROR: Firmware write exceeds declared FW_SIZE!");
                  Update.abort();
                  fwUpdateInProgress = false;
                  bleUploadError = true;
                  return;
               }
               size_t written = Update.write(bleWriteBuffer, bleWriteBufferPos);
               if (written != bleWriteBufferPos) {
                  Serial.println("[BLE] ERROR: Update.write failed during FLUSH!");
                  Update.printError(Serial);
                  Update.abort();
                  fwUpdateInProgress = false;
                  bleUploadError = true;
                  return;
               }
               bleRunningCrc = crc32_le(bleRunningCrc, bleWriteBuffer, bleWriteBufferPos);
               bleBytesReceived += bleWriteBufferPos;
               bleWriteBufferPos = 0;
               bleExpectedSeq = 0;
            }
            else if (bleFile && bleWriteBufferPos > 0) {
               if (!writeAndVerifyFlash(bleFile, bleBytesReceived, bleWriteBuffer, bleWriteBufferPos)) {
                  Serial.println("[BLE] ERROR: Flash write/verify failed during FLUSH!");
                  bleUploadError = true;
                  return;
               }
               bleRunningCrc = crc32_le(bleRunningCrc, bleWriteBuffer, bleWriteBufferPos);
               bleBytesReceived += bleWriteBufferPos;
               bleWriteBufferPos = 0;
               bleExpectedSeq = 0;
            }
         }
         else if (cmd == "CLEAR") {
            bleWriteBufferPos = 0;
            bleExpectedSeq = 0;
            bleSeqError = false;
            Serial.println("[BLE] Buffer CLEARED due to packet loss!");
         }
         else if (cmd == "END" || cmd.startsWith("END:")) {
            const uint32_t expectedImageBytes = (EPD_WIDTH * EPD_HEIGHT / 2);
            bool hasExpectedCrc = cmd.startsWith("END:") && cmd.length() > 4;
            uint32_t expectedTotalCrc = hasExpectedCrc ? (uint32_t)strtoul(cmd.c_str() + 4, nullptr, 16) : 0;

            if (bleFile) {
               if (!bleUploadError && !bleSeqError && bleWriteBufferPos > 0) {
                  if (!writeAndVerifyFlash(bleFile, bleBytesReceived, bleWriteBuffer, bleWriteBufferPos)) {
                     bleUploadError = true;
                  }
                  else {
                     bleRunningCrc = crc32_le(bleRunningCrc, bleWriteBuffer, bleWriteBufferPos);
                     bleBytesReceived += bleWriteBufferPos;
                  }
                  bleWriteBufferPos = 0;
               }

               uint32_t flashCrc = 0;
               bool flashVerifyOk = false;
               if (!bleUploadError && !bleSeqError && bleBytesReceived == expectedImageBytes && bleWriteBuffer != nullptr) {
                  flashVerifyOk = verifyFlashSlotCrc(bleFile, bleBytesReceived, bleWriteBuffer, BLE_BUFFER_SIZE, flashCrc);
                  if (flashVerifyOk && flashCrc != bleRunningCrc) {
                     Serial.printf("[BLE] ERROR: Flash readback CRC mismatch! Flash=0x%08X, RAM=0x%08X\n",
                                   flashCrc, bleRunningCrc);
                     flashVerifyOk = false;
                  }
                  if (flashVerifyOk && hasExpectedCrc && flashCrc != expectedTotalCrc) {
                     Serial.printf("[BLE] ERROR: End-to-end CRC mismatch! Flash=0x%08X, Client=0x%08X\n",
                                   flashCrc, expectedTotalCrc);
                     flashVerifyOk = false;
                  }
               }

               if (bleUploadError || bleSeqError || bleBytesReceived != expectedImageBytes || !flashVerifyOk) {
                  Serial.printf("[BLE] WARNING: Invalid BLE payload (%u / %u bytes, verify=%d, err=%d). Discarding!\n",
                                bleBytesReceived, expectedImageBytes, flashVerifyOk, bleUploadError || bleSeqError);
                  discardFlashSlot(bleFile);
                  bleUploadError = true;
               }
               else {
                  bleFinalFlashCrc = flashCrc;
                  bleFile.close();
                  bleFile = SerialFlashFile();
                  settings.imageMode = 0;
                  settings.lastModified = "";
                  saveSettingsToFlash(EEPROM_SETTINGS_ADR);
               }
            }
            else {
               bleUploadError = true;
            }
            if (bleWriteBuffer != nullptr) {
               free(bleWriteBuffer);
               bleWriteBuffer = nullptr;
            }
            Serial.printf("[BLE] Upload ENDED. Bytes: %u, FlashCRC: 0x%08X (%s)\n",
                          bleBytesReceived, bleFinalFlashCrc, bleUploadError ? "ERROR" : "OK");
         }
         else if (cmd == "APPLY") {
            Serial.println("[BLE] Settings APPLY received.");
            applyPending = true;
         }
         else if (cmd == "SAVE_SETTINGS") {
            Serial.println("[BLE] SAVE_SETTINGS received.");
            storeSleepTimeMem(settings.timeout);
            saveSettingsToFlash(EEPROM_SETTINGS_ADR);
         }
         else if (cmd == "RESET") {
            Serial.println("[BLE] Settings RESET received.");
            resetAll(true);
            // Restart from the main loop (as after a firmware update), so that this write is still
            // answered. A restart in here made the client report a failed reset.
            fwRebootScheduledAt = millis();
            fwRebootPending = true;
         }
         else if (cmd == "START_FW" || cmd.startsWith("START_FW:")) {
            if (bleFile) {
               discardFlashSlot(bleFile);
            }
            if (fwUpdateInProgress) {
               Update.abort();
               fwUpdateInProgress = false;
            }
            fwRebootPending = false;
            bleDisplayBusy = false;
            bleUploadError = false;
            bleSeqError = false;
            bleExpectedSeq = 0;
            bleExpectedFwBytes = (cmd.startsWith("START_FW:") && cmd.length() > 9)
                                     ? (uint32_t)strtoul(cmd.c_str() + 9, nullptr, 10)
                                     : 0;
            bleBytesReceived = 0;
            bleWriteBufferPos = 0;
            bleRunningCrc = 0;
            bleFinalFlashCrc = 0;
            bleProtocolV2 = false;

            if (cmd.startsWith("START_FW:") && (bleExpectedFwBytes < 65536 || bleExpectedFwBytes > MAX_OTA_FW_SIZE)) {
               Serial.printf("[BLE] ERROR: Invalid firmware size %u (max %lu)!\n", bleExpectedFwBytes, (unsigned long)MAX_OTA_FW_SIZE);
               bleUploadError = true;
               return;
            }

            if (bleWriteBuffer == nullptr) {
               bleWriteBuffer = (uint8_t *)malloc(BLE_BUFFER_SIZE);
            }
            if (bleWriteBuffer == nullptr) {
               Serial.println("[BLE] ERROR: Failed to allocate memory for firmware buffer!");
               bleUploadError = true;
               return;
            }
            tickerFailsave.detach();
            size_t beginSize = (bleExpectedFwBytes > 0) ? (size_t)bleExpectedFwBytes : (size_t)UPDATE_SIZE_UNKNOWN;
            if (!Update.begin(beginSize)) {
               Update.printError(Serial);
               free(bleWriteBuffer);
               bleWriteBuffer = nullptr;
               bleUploadError = true;
            }
            else {
               fwUpdateInProgress = true;
               Serial.println("[BLE] Firmware Update STARTED.");
            }
         }
         else if (cmd.startsWith("FW_SIZE:")) {
            uint32_t fwSize = (cmd.length() > 8) ? (uint32_t)strtoul(cmd.c_str() + 8, nullptr, 10) : 0;
            if (!fwUpdateInProgress || bleBytesReceived > 0 || fwSize < 65536 || fwSize > MAX_OTA_FW_SIZE) {
               Serial.printf("[BLE] ERROR: Rejected FW_SIZE %u (max %lu)!\n", fwSize, (unsigned long)MAX_OTA_FW_SIZE);
               if (fwUpdateInProgress) {
                  Update.abort();
                  fwUpdateInProgress = false;
               }
               bleUploadError = true;
               return;
            }
            Update.abort();
            if (!Update.begin(fwSize)) {
               Update.printError(Serial);
               fwUpdateInProgress = false;
               bleUploadError = true;
               return;
            }
            bleExpectedFwBytes = fwSize;
            Serial.printf("[BLE] Firmware target size set to %u bytes.\n", bleExpectedFwBytes);
         }
         else if (cmd == "END_FW" || cmd.startsWith("END_FW:")) {
            bool hasExpectedCrc = cmd.startsWith("END_FW:") && cmd.length() > 7;
            uint32_t expectedTotalCrc = hasExpectedCrc ? (uint32_t)strtoul(cmd.c_str() + 7, nullptr, 16) : 0;

            if (!fwUpdateInProgress) {
               bleUploadError = true;
            }
            if (fwUpdateInProgress && !bleUploadError && !bleSeqError && bleWriteBufferPos > 0) {
               if (bleBytesReceived == 0 && bleWriteBuffer[0] != 0xE9) {
                  bleUploadError = true;
               }
               else if (bleExpectedFwBytes > 0 && (bleBytesReceived + bleWriteBufferPos) > bleExpectedFwBytes) {
                  bleUploadError = true;
               }
               else if (Update.write(bleWriteBuffer, bleWriteBufferPos) != bleWriteBufferPos) {
                  bleUploadError = true;
               }
               else {
                  bleRunningCrc = crc32_le(bleRunningCrc, bleWriteBuffer, bleWriteBufferPos);
                  bleBytesReceived += bleWriteBufferPos;
               }
               bleWriteBufferPos = 0;
            }
            if (bleExpectedFwBytes > 0 && bleBytesReceived != bleExpectedFwBytes) {
               Serial.printf("[BLE] ERROR: Firmware size mismatch! Received=%u, Expected=%u\n",
                             bleBytesReceived, bleExpectedFwBytes);
               bleUploadError = true;
            }
            if (hasExpectedCrc && bleRunningCrc != expectedTotalCrc) {
               Serial.printf("[BLE] ERROR: Firmware CRC mismatch! Device=0x%08X, Client=0x%08X\n",
                             bleRunningCrc, expectedTotalCrc);
               bleUploadError = true;
            }
            bool updateEndOk = (!bleUploadError && !bleSeqError && bleBytesReceived >= 65536)
                                   ? Update.end(bleExpectedFwBytes == 0)
                                   : false;
            fwUpdateInProgress = false;
            if (bleWriteBuffer != nullptr) {
               free(bleWriteBuffer);
               bleWriteBuffer = nullptr;
            }
            if (updateEndOk) {
               bleFinalFlashCrc = bleRunningCrc;
               bleWriteBufferPos = 0;
               fwRebootScheduledAt = millis();
               fwRebootPending = true;
               Serial.printf("[BLE] Firmware Update SUCCESS (Bytes: %u, CRC: 0x%08X). Rebooting shortly...\n",
                             bleBytesReceived, bleFinalFlashCrc);
            }
            else {
               Update.printError(Serial);
               Update.abort();
               Serial.println("[BLE] Firmware Update FAILED.");
               bleUploadError = true;
               bleWriteBufferPos = 0xFFFF;
            }
         }
      }
      else if (uuidStr == "10000003-0000-0000-0000-000000000001") {
         if ((bleFile || fwUpdateInProgress) && pData && bleWriteBuffer != nullptr && !bleUploadError) {
            if (bleProtocolV2) {
               if (bleSeqError || dataLen <= 1)
                  return;
               uint8_t seq = pData[0];
               if (seq != bleExpectedSeq) {
                  Serial.printf("[BLE] Seq Error! Expected %u, got %u\n", bleExpectedSeq, seq);
                  bleSeqError = true;
                  return;
               }
               bleExpectedSeq++;
               size_t actualDataLen = dataLen - 1;
               if (bleWriteBufferPos + actualDataLen <= BLE_BUFFER_SIZE) {
                  memcpy(bleWriteBuffer + bleWriteBufferPos, pData + 1, actualDataLen);
                  bleWriteBufferPos += actualDataLen;
               }
               else {
                  Serial.println("[BLE] ERROR: RAM buffer overflow in V2!");
                  bleSeqError = true;
               }
            }
            else if (dataLen > 4) {
               uint32_t packetCrc = pData[0] | (pData[1] << 8) | (pData[2] << 16) | (pData[3] << 24);
               size_t actualDataLen = dataLen - 4;
               uint32_t calculatedCrc = calcCRC32(pData + 4, actualDataLen);

               if (packetCrc == calculatedCrc) {
                  if (bleWriteBufferPos + actualDataLen <= BLE_BUFFER_SIZE) {
                     memcpy(bleWriteBuffer + bleWriteBufferPos, pData + 4, actualDataLen);
                     bleWriteBufferPos += actualDataLen;
                  }
                  else {
                     Serial.println("[BLE] ERROR: RAM buffer overflow! Checkpoint logic failed.");
                     bleSeqError = true;
                  }
               }
               else {
                  Serial.printf("[BLE] CRC Error! Expected 0x%08X, got 0x%08X\n", calculatedCrc, packetCrc);
                  bleSeqError = true;
               }
            }
         }
      }
   };

   void onStatus(NimBLECharacteristic *pCharacteristic, int code) override {
      Serial.printf("Notification/Indication return code: %d, %s\n", code, NimBLEUtils::returnCodeToString(code));
   }
} chrCallbacks;

/** Handler class for descriptor actions */
class DescriptorCallbacks : public NimBLEDescriptorCallbacks
{
   void onWrite(NimBLEDescriptor *pDescriptor, NimBLEConnInfo &connInfo) override {
      std::string dscVal = pDescriptor->getValue();
      Serial.printf("[BLE] Descriptor written value: %s\n", dscVal.c_str());
   }

   void onRead(NimBLEDescriptor *pDescriptor, NimBLEConnInfo &connInfo) override {
      Serial.printf("[BLE] %s Descriptor read\n", pDescriptor->getUUID().toString().c_str());
   }
} dscCallbacks;

// System info for the BLE client. setupTimeout: the frame ends the setup mode on its own.
static String systemInfoJson(bool isCharging, bool setupTimeout = false) {
   JsonDocument sysDoc;
   sysDoc["voltage"] = systemData.vddValue;
   sysDoc["usb"] = systemData.usbConnected;
   sysDoc["charging"] = isCharging;
   sysDoc["version"] = SOFTWARE_VERSION;
   sysDoc["fw"] = "offline";
#ifdef EPD_TYPE_13INCH
   sysDoc["display"] = "13";
#else
   sysDoc["display"] = "7";
#endif
   if (setupTimeout)
      sysDoc["setupTimeout"] = true;
   String out;
   serializeJson(sysDoc, out);
   return out;
}

bool BleInit(String deviceId, bool enable) {
   if (!enable) {
      if (wifiSettings.bleInitOk) {
         ledBlink(500, true);
         wifiSettings.bleInitOk = false;
         pAdvertising->stop();
         esp_bt_controller_enable(ESP_BT_MODE_BLE);
         esp_bt_controller_disable();
         esp_bt_controller_mem_release(ESP_BT_MODE_BTDM);
         // NimBLEDevice::deinit(false); //crashes with panic
         Serial.println("[BLE] BLE stopped");
      }
      return true;
   }
   if (wifiSettings.bleInitOk) {
      Serial.println("[BLE] already initialized, skip...");
      return true;
   }
   String wifiSsidScan;
   WiFi.mode(WIFI_STA);
   delay(1);

   NimBLEDevice::init(deviceId.c_str());
   NimBLEDevice::setMTU(517);
   // NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
   NimBLEDevice::setSecurityAuth(false, false, true);

#ifdef ESP_PLATFORM
   NimBLEDevice::setPower(ESP_PWR_LVL_P9);
#else
   NimBLEDevice::setPower(9);
#endif

   pServer = NimBLEDevice::createServer();
   pServer->setCallbacks(&serverCallbacks);

   NimBLEService *deviceDataService = pServer->createService("7f74170e-7b0e-11ed-a1eb-0242ac120002");
   wifiConnectedCharacteristic = deviceDataService->createCharacteristic("4c578d4c-7b0e-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
   wifiInfoCharacteristic = deviceDataService->createCharacteristic("4c578d4d-7b0e-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
   wifiScanCharacteristic = deviceDataService->createCharacteristic("5131a3fc-7b0e-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
   systemInfoCharacteristic = deviceDataService->createCharacteristic("60000001-7b0e-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
   if (wifiSsidScan.length() > 0) {
      wifiScanCharacteristic->setValue(wifiSsidScan.c_str());
   }

   NimBLEService *wifiDataService = pServer->createService("0515c086-7b0c-11ed-a1eb-0242ac120002");
   NimBLECharacteristic *wifiSsidCharacteristic = wifiDataService->createCharacteristic("090b0ef2-7b0d-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   // Passwords are write-only: BLE has no authentication, a stored password must never be readable.
   NimBLECharacteristic *wifiPwCharacteristic = wifiDataService->createCharacteristic("a62eed84-7b0d-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::WRITE);

   wifiSsidCharacteristic->setCallbacks(&chrCallbacks);
   wifiPwCharacteristic->setCallbacks(&chrCallbacks);
   wifiConnectedCharacteristic->setCallbacks(&chrCallbacks);
   wifiInfoCharacteristic->setCallbacks(&chrCallbacks);
   wifiScanCharacteristic->setCallbacks(&chrCallbacks);

   NimBLE2904 *wifiSsidDescriptor = (NimBLE2904 *)wifiSsidCharacteristic->createDescriptor("2904");
   NimBLE2904 *wifiPwDescriptor = (NimBLE2904 *)wifiPwCharacteristic->createDescriptor("2904");
   NimBLE2904 *wifiScanDescriptor = (NimBLE2904 *)wifiScanCharacteristic->createDescriptor("2904");

   wifiSsidDescriptor->setDescription(0x00);
   wifiSsidDescriptor->setNamespace(0x00);
   wifiSsidDescriptor->setFormat(NimBLE2904::FORMAT_UTF8);
   wifiSsidDescriptor->setCallbacks(&dscCallbacks);

   wifiPwDescriptor->setDescription(0x00);
   wifiPwDescriptor->setNamespace(0x00);
   wifiPwDescriptor->setFormat(NimBLE2904::FORMAT_UTF8);
   wifiPwDescriptor->setCallbacks(&dscCallbacks);

   wifiScanDescriptor->setDescription(0x00);
   wifiScanDescriptor->setNamespace(0x00);
   wifiScanDescriptor->setFormat(NimBLE2904::FORMAT_UTF8);
   wifiScanDescriptor->setCallbacks(&dscCallbacks);

   NimBLEService *epaperSettingsService = pServer->createService("10000000-0000-0000-0000-000000000001");
   NimBLECharacteristic *urlCharacteristic = epaperSettingsService->createCharacteristic("10000001-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *imageModeCharacteristic = epaperSettingsService->createCharacteristic("10000002-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *uploadDataCharacteristic = epaperSettingsService->createCharacteristic("10000003-0000-0000-0000-000000000001", NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
   NimBLECharacteristic *uploadCmdCharacteristic = epaperSettingsService->createCharacteristic("10000004-0000-0000-0000-000000000001", NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::READ);
   NimBLECharacteristic *timeoutCharacteristic = epaperSettingsService->createCharacteristic("10000005-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *settingsUrlCharacteristic = epaperSettingsService->createCharacteristic("1000000b-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *httpAuthUserCharacteristic = epaperSettingsService->createCharacteristic("10000007-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *httpAuthPasswordCharacteristic = epaperSettingsService->createCharacteristic("10000008-0000-0000-0000-000000000001", NIMBLE_PROPERTY::WRITE); // write-only, see WiFi password
   NimBLECharacteristic *motionWakeupCharacteristic = epaperSettingsService->createCharacteristic("10000009-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *chargerModeCharacteristic = epaperSettingsService->createCharacteristic("1000000a-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *autoRotationCharacteristic = epaperSettingsService->createCharacteristic("1000000c-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *fwVersionCharacteristic = epaperSettingsService->createCharacteristic("1000000d-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ);

   wifiSsidCharacteristic->setCallbacks(&chrCallbacks);
   wifiPwCharacteristic->setCallbacks(&chrCallbacks);
   urlCharacteristic->setCallbacks(&chrCallbacks);
   imageModeCharacteristic->setCallbacks(&chrCallbacks);
   uploadDataCharacteristic->setCallbacks(&chrCallbacks);
   uploadCmdCharacteristic->setCallbacks(&chrCallbacks);
   timeoutCharacteristic->setCallbacks(&chrCallbacks);
   settingsUrlCharacteristic->setCallbacks(&chrCallbacks);
   httpAuthUserCharacteristic->setCallbacks(&chrCallbacks);
   ;
   httpAuthPasswordCharacteristic->setCallbacks(&chrCallbacks);
   motionWakeupCharacteristic->setCallbacks(&chrCallbacks);
   chargerModeCharacteristic->setCallbacks(&chrCallbacks);
   autoRotationCharacteristic->setCallbacks(&chrCallbacks);

   // Services are started when the server is started

   wifiSsidCharacteristic->setValue(wifiSettings.ssid.c_str());
   uint8_t initVal = wifiSettings.wifiIsConnected ? 1 : 0;
   wifiConnectedCharacteristic->setValue(&initVal, 1);
   wifiInfoCharacteristic->setValue("{}");
   wifiScanCharacteristic->setValue(wifiSsidScan);

   bool isChargingInit = false;
   if (settings.chargerMode) {
      isChargingInit = chargeMode(settings.chargerMode);
   }
   systemInfoCharacteristic->setValue(systemInfoJson(isChargingInit).c_str());

   urlCharacteristic->setValue(settings.downloadUrl.c_str());
   char imgModeStr[16];
   snprintf(imgModeStr, sizeof(imgModeStr), "%d", settings.imageMode);
   imageModeCharacteristic->setValue(imgModeStr);

   char timeoutStr[16];
   snprintf(timeoutStr, sizeof(timeoutStr), "%d", settings.timeout);
   timeoutCharacteristic->setValue(timeoutStr);
   settingsUrlCharacteristic->setValue(settings.settingsUrl.c_str());
   httpAuthUserCharacteristic->setValue(settings.httpAuthUser.c_str());
   motionWakeupCharacteristic->setValue(settings.motionWakeup ? "1" : "0");
   chargerModeCharacteristic->setValue(settings.chargerMode ? "1" : "0");
   autoRotationCharacteristic->setValue(settings.autoRotation ? "1" : "0");
   fwVersionCharacteristic->setValue(SOFTWARE_VERSION);

   pAdvertising = NimBLEDevice::getAdvertising();
   pAdvertising->setName(deviceId.c_str());
   pAdvertising->addServiceUUID(wifiDataService->getUUID());
   pAdvertising->addServiceUUID(deviceDataService->getUUID());
   pAdvertising->addServiceUUID(epaperSettingsService->getUUID());
   pAdvertising->enableScanResponse(true);
   pAdvertising->start();
   ledBlink(200, true);
   Serial.printf("[BLE] BLE Advertising started: %s \n", deviceId.c_str());
   wifiSettings.bleInitOk = true;
   return true;
}
// https://forum.arduino.cc/index.php?topic=565603.0
int downloadAndSaveFile(String fileName, String url) {
   int success = 0;
   tempLastModified = "";
   lastDownloadedBytes = 0;
   serverSleepSeconds = 0;
   WiFi.setSleep(false);
   WiFiClientSecure secureClient;
   secureClient.setInsecure();
   HTTPClient http;
   http.setTimeout(10000);
   http.setReuse(true);
   http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

   if (url.indexOf("https:") >= 0) {
      Serial.println("[DL] Download HTTPS");
      http.begin(secureClient, url);
   }
   else {
      Serial.println("[DL] Download HTTP");
      http.begin(url);
   }

   if (settings.httpAuthUser.length() > 0) {
      http.setAuthorization(settings.httpAuthUser.c_str(), settings.httpAuthPassword.c_str());
      Serial.println("[DL] HTTP Auth enabled");
   }

   bool canSkipIfUnchanged = !settings.forceDownload && hasValidFlashImage("tmp.bmp");
   if (canSkipIfUnchanged && settings.lastModified.length() > 0) {
      if (settings.lastModified.startsWith("etag:"))
         http.addHeader("If-None-Match", settings.lastModified.substring(5));
      else
         http.addHeader("If-Modified-Since", settings.lastModified);
   }

   const char *headerKeys[] = {"Last-Modified", "ETag", "X-OpenPaper-Sleep-Seconds", "Transfer-Encoding"};
   http.collectHeaders(headerKeys, 4);
   addTelemetryHeaders(http);

   int httpCode = http.GET();
   int srvSleep = http.header("X-OpenPaper-Sleep-Seconds").toInt();
   uint32_t srvSleepAtMs = millis();

   if (httpCode == HTTP_CODE_NOT_MODIFIED && canSkipIfUnchanged) {
      Serial.println("[DL] Image unchanged (HTTP 304); skipping download.");
      if (srvSleep >= 60 && srvSleep <= 86400) {
         serverSleepSeconds = srvSleep;
         serverSleepReceivedMs = srvSleepAtMs;
      }
      http.end();
      return 1;
   }

   if (httpCode > 0) {
      // file found at server
      if (httpCode == HTTP_CODE_OK) {
         String etag = http.header("ETag");
         etag.trim();
         String lastMod = http.header("Last-Modified");
         lastMod.trim();
         String validator = (etag.length() > 0) ? ("etag:" + etag) : lastMod;
         if (validator.length() > MAX_SETTING_STRING_LEN) {
            // Does not fit into EEPROM; a truncated validator would never match.
            validator = (lastMod.length() <= MAX_SETTING_STRING_LEN) ? lastMod : String("");
         }
         if (canSkipIfUnchanged && validator.length() > 0 &&
             (validator == settings.lastModified || lastMod == settings.lastModified)) {
            Serial.println("[DL] File not modified, skipping download.");
            if (srvSleep >= 60 && srvSleep <= 86400) {
               serverSleepSeconds = srvSleep;
               serverSleepReceivedMs = srvSleepAtMs;
            }
            http.end();
            return 1; // 1 means not modified
         }

         int len = http.getSize(); // -1: the server did not send the length
         httpFileSize = len;
         String transferEncoding = http.header("Transfer-Encoding");
         transferEncoding.toLowerCase();
         const bool chunked = transferEncoding.indexOf("chunked") >= 0;
         if (chunked)
            len = -1; // the end is marked by the last chunk

         if (!prepareFlashSlot(fileName.c_str(), downloadSlotSize(), saveFile, false)) {
            http.end();
            return DL_FLASH_ERROR;
         }
         if (len > 0 && (uint32_t)len > saveFile.size()) {
            Serial.printf("[DL] File too large (%d bytes, at most %u), not downloaded.\n", len, (unsigned)saveFile.size());
            saveFile.close();
            http.end();
            return DL_TOO_LARGE;
         }
         rawSlotBegin();
         Serial.printf("[DL] Download Size: %d%s\n", len, chunked ? " (chunked)" : "");
         int buff_size = 2048;
         unsigned char *buff = (unsigned char *)malloc(buff_size);
         if (buff == nullptr) {
            Serial.println("[DL] WARNING: Failed to allocate 2048 bytes, trying 512 bytes...");
            buff_size = 512;
            buff = (unsigned char *)malloc(buff_size);
         }
         if (buff == nullptr) {
            Serial.println("[DL] ERROR: Failed to allocate memory for download buffer!");
            discardFlashSlot(saveFile);
            http.end();
            return DL_NO_MEMORY;
         }

         WiFiClient *stream = http.getStreamPtr();
         ChunkedDecoder chunkDecoder;
         unsigned long lastDataTime = millis();
         bool dlFailed = false;

         // The body ends after Content-Length bytes, with the last chunk, or (neither given)
         // when the server closes the connection.
         while (!chunkDecoder.done() && (http.connected() || stream->available() > 0) && (len > 0 || len == -1)) {
            int available_bytes = stream->available();
            if (available_bytes > 0) {
               int to_read = (available_bytes > buff_size) ? buff_size : available_bytes;
               if (len > 0 && to_read > len)
                  to_read = len;
               int c = stream->read(buff, to_read);
               if (c > 0) {
                  lastDataTime = millis();
                  if (len > 0) {
                     len -= c;
                  }
                  const bool stored = chunked ? chunkDecoder.feed(buff, c, rawSlotWrite) : rawSlotWrite(buff, c);
                  if (!stored) {
                     Serial.println(rawSlot.overflow ? "[DL] File does not fit into the flash" : "[DL] Body not readable or flash write failed");
                     dlFailed = true;
                     break;
                  }
               }
               else if (c < 0) {
                  Serial.println("[DL] Stream read error");
                  dlFailed = true;
                  break;
               }
            }
            else {
               // No data available currently
               if (millis() - lastDataTime > 15000) {
                  Serial.println("[DL] Stream read timeout");
                  dlFailed = true;
                  break;
               }
               delay(1);
            }

            if (WiFi.status() != WL_CONNECTED) {
               Serial.println("[DL] WiFi disconnected during download");
               dlFailed = true;
               break;
            }
         }

         free(buff);

         lastDownloadedBytes = rawSlot.written;
         if (rawSlot.overflow) {
            Serial.printf("[DL] File too large (more than %u bytes), discarding.\n", (unsigned)saveFile.size());
            discardFlashSlot(saveFile);
            http.end();
            return DL_TOO_LARGE;
         }
         const bool complete = chunked ? chunkDecoder.done() : (httpFileSize <= 0 || lastDownloadedBytes == (uint32_t)httpFileSize);
         if (dlFailed || WiFi.status() != WL_CONNECTED || lastDownloadedBytes == 0 || !complete || !waitFlashReady()) {
            Serial.printf("[DL] Download incomplete (%u / %d bytes), discarding.\n", lastDownloadedBytes, httpFileSize);
            discardFlashSlot(saveFile);
            http.end();
            return DL_INCOMPLETE;
         }

         tempLastModified = validator;
         if (srvSleep >= 60 && srvSleep <= 86400) {
            serverSleepSeconds = srvSleep;
            serverSleepReceivedMs = srvSleepAtMs;
         }
         saveFile.close();
      }
      else {
         Serial.printf("[DL] Server answered with HTTP %d\n", httpCode);
         success = DL_HTTP_STATUS;
      }
   }
   else {
      Serial.printf("[DL] Error on HTTP request: %s\n", http.errorToString(httpCode).c_str());
      success = DL_REQUEST_FAILED;
   }
   http.end();
   return success;
}

// https://github.com/zenmanenergy/ESP8266-Arduino-Examples/blob/master/helloWorld_urlencoded/urlencode.ino
unsigned char h2int(char c) {
   if (c >= '0' && c <= '9') {
      return ((unsigned char)c - '0');
   }
   if (c >= 'a' && c <= 'f') {
      return ((unsigned char)c - 'a' + 10);
   }
   if (c >= 'A' && c <= 'F') {
      return ((unsigned char)c - 'A' + 10);
   }
   return (0);
}

String urldecode(String str) {
   String encodedString = "";
   char c;
   char code0;
   char code1;
   for (int i = 0; i < str.length(); i++) {
      c = str.charAt(i);
      if (c == '+') {
         encodedString += ' ';
      }
      else if (c == '%') {
         i++;
         code0 = str.charAt(i);
         i++;
         code1 = str.charAt(i);
         c = (h2int(code0) << 4) | h2int(code1);
         encodedString += c;
      }
      else {
         encodedString += c;
      }
      yield();
   }
   return encodedString;
}

int storeSleepTimeMem(int updateTime) {
   int returnSleepTime = readIntFromFlash(210);
   if (returnSleepTime == -1)
      returnSleepTime = DEFAULT_SLEEP;
   if (updateTime > 0) {
      if (returnSleepTime != updateTime) {
         systemData.newSleepTimeSet = true;
         if (DEBUG_FLAG)
            Serial.printf("[MEM] Update Sleep Time to %d\n", updateTime);
         writeIntToFlash(updateTime, 210);
      }
      returnSleepTime = updateTime;
   }
   else {
      if (DEBUG_FLAG)
         Serial.printf("[MEM] Get Sleep Time: %d\n", returnSleepTime);
   }
   return returnSleepTime;
}

void debugFS() {
#if DEBUG
   Serial.printf("[MAIN] SPIFFS usage %d/%d heap free: %d/%d\n", SPIFFS.usedBytes(), SPIFFS.totalBytes(), ESP.getFreeHeap(), ESP.getHeapSize());
#endif
}

void sdTest() {
   // Test read/write
   FsFile testFile;
   if (testFile.open("test.txt", O_WRONLY | O_CREAT | O_TRUNC)) {
      Serial.println("Writing to test.txt...");
      testFile.println("Hello SD Card! This is a test of the SdFat library.");
      testFile.close();
      Serial.println("Write complete.");

      if (testFile.open("test.txt", O_RDONLY)) {
         Serial.println("Reading from test.txt:");
         while (testFile.available()) {
            Serial.write(testFile.read());
         }
         testFile.close();
         Serial.println("\nRead complete.");
      }
      else {
         Serial.println("Failed to open test.txt for reading.");
      }
   }
   else {
      Serial.println("Failed to create test.txt.");
   }
}

bool sdInit() {
   if (systemData.sdReady) {
      if (DEBUG_FLAG)
         Serial.println("[SD] skip, init is done...");
      return true;
   }
   if (!sd.begin(SdSpiConfig(CS_SD_PIN, SHARED_SPI, DISPLAY_SPI_SPEED))) {
      Serial.println("[SD] mount failed, attempting to format the card...");
      FatFormatter fatFormatter;
      uint8_t buffer[512];
      SdCardFactory cardFactory;
      SdCard *m_card = cardFactory.newCard(SdSpiConfig(CS_SD_PIN, SHARED_SPI, DISPLAY_SPI_SPEED));

      if (!m_card || m_card->errorCode()) {
         Serial.println("[SD] Hardware error: could not detect SD card!");
         return false;
      }
      else {
         bool formatSuccess = fatFormatter.format(m_card, buffer, &Serial);
         if (formatSuccess) {
            Serial.println("Format complete! Retrying mount...");
            if (sd.begin(SdSpiConfig(CS_SD_PIN, SHARED_SPI, DISPLAY_SPI_SPEED))) {
               Serial.println("[SD] mounted successfully after format.");
               systemData.sdReady = true;
               return true;
            }
            else {
               Serial.println("[SD] mount failed even after format.");
               return false;
            }
         }
         else {
            Serial.println("[SD] Format failed!");
            return false;
         }
      }
   }
   else {
      Serial.println("[SD] initialization done.");
      systemData.sdReady = true;
      return true;
   }
   return false;
}

int loadImageFromWeb(String url, String fileName) {
   if (url.length() < 1)
      return -2;
   Serial.print("[DL] Download Image file: ");
   Serial.println(url);
   // int setImage = 0; // Trigger refresh
   int downloadOk = 0;
   String newUrl = getRedirect(url);
   const int maxAttempts = 3;
   for (int attempt = 1; attempt <= maxAttempts; attempt++) {
      debugFS();
      downloadOk = downloadAndSaveFile(fileName, newUrl);
      if (downloadOk == DL_OK || downloadOk == DL_NOT_MODIFIED) {
         if (settings.forceDownload)
            downloadOk = DL_OK;
         return downloadOk;
      }

      if ((downloadOk != DL_REQUEST_FAILED && downloadOk != DL_INCOMPLETE) || attempt == maxAttempts)
         break;
      if (WiFi.status() != WL_CONNECTED) {
         WiFi.disconnect(true);
         WiFi.begin(wifiSettings.ssid.c_str(), wifiSettings.pss.c_str());
         delay(3000);
      }
      else {
         delay(1000);
      }
   }
   Serial.printf("[DL] Download failed (%d)\n", downloadOk);
   return downloadOk;
}

String setLeadingZero(String input) {
   String result = "";
   if (input.length() == 1) {
      result = "0" + input;
   }
   else {
      result = input;
   }

   return result;
}

void setDeviceUid() {
   byte mac[6];
   WiFi.mode(WIFI_STA);
   WiFi.macAddress(mac);
   if (DEBUG_FLAG) {
      Serial.print("[WIFI] MAC: ");
      for (int i = 0; i < 6; i++) {
         Serial.printf("%02X", mac[i]);
         if (i < 5) {
            Serial.print(":");
         }
      }
      Serial.println();
   }
   String uniq = setLeadingZero(String(mac[0], HEX)) + setLeadingZero(String(mac[1], HEX)) + setLeadingZero(String(mac[2], HEX)) + setLeadingZero(String(mac[3], HEX)) + setLeadingZero(String(mac[4], HEX)) + setLeadingZero(String(mac[5], HEX));
   const uint8_t MSG_BUF_SIZE = 100;
   char mesg[MSG_BUF_SIZE] = {'\0'}; // Serial input message buffer
   uniq.toCharArray(mesg, MSG_BUF_SIZE);
   sprintf(CLIENT_ID, "%s%s", EPD_TYPE_IDENTIFIER, mesg);
   Serial.print("[MAIN] UID: ");
   Serial.println(CLIENT_ID);
}

// sleep x seconds
void gotToDeepSleep(int wakeuptimeout, bool showScreen, bool motionWake) {
   Serial.printf("[MAIN] Going to Sleep for %d seconds (MotionWake: %d)\n", wakeuptimeout, motionWake);
   // Standby: the charger is off and stays off (pin held low through deep sleep). Only if the
   // user switched "Charger Mode" on, it keeps charging while the frame sleeps.
   chargeMode(settings.chargerMode);
   checkOrientationInBackground(0, false);
   if (!settings.sleepDisabled)
      WiFi.disconnect(true);
   if (motionWake) {
      accIntSet(80); // Set acc int wakeup /TODO: disable if no motion wakeup
   }
   else {
      accIntSet(0);
   }
   waitDisplayComplete(false);
   if (wakeuptimeout <= 0 && showScreen) {
      displayTurnOn();
      waitDisplayComplete(true);
   }
   ledBlink(0, false);
   delay(5);
   display.hibernate();
   powerSupplyDisplay(false);
   delay(5);
   // digitalWrite(RST_PIN, 0);
   Serial.flush();
   delay(10);
   if (!settings.sleepDisabled)
      setCpuFrequencyMhz(40);
   delay(5);
   pinMode(RST_PIN, INPUT);
   pinMode(CS_EPD_PIN, INPUT);
   pinMode(DC_PIN, INPUT);
   if (!settings.sleepDisabled)
      pinMode(LED_PIN, INPUT);
   pinMode(CS_FLASH_PIN, INPUT);
   pinMode(SCK_PIN, INPUT);
   pinMode(MOSI_PIN, INPUT);
   pinMode(MISO_PIN, INPUT);
   pinMode(I2C_SDA_PIN, INPUT);
   pinMode(I2C_SCL_PIN, INPUT);
   pinMode(BAT_VOLT_EN_PIN, INPUT);
   pinMode(12, INPUT); // USB TEST PINS
   pinMode(13, INPUT); // USB TEST PINS
   if (settings.sleepDisabled) {
      Serial.printf("[SLEEP] enter soft sleep\n");
      tickerFailsave.detach();
      ledBlink(2000, true);
      while (true) {
         // TODO: add trigger for reboot via wifi or ble for soft sleep
         delay(100);
      }
   }
   esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
   if (wakeuptimeout > 0) {
      esp_sleep_enable_timer_wakeup(wakeuptimeout * uS_TO_S_FACTOR);
   }
   else {
      esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
   }
   if (motionWake) {
      esp_sleep_enable_ext1_wakeup_io(BUTTON_PIN_BITMASK(GPIO_NUM_0), ESP_EXT1_WAKEUP_ANY_HIGH);
      rtc_gpio_pulldown_en(GPIO_NUM_0);
      rtc_gpio_pullup_dis(GPIO_NUM_0);
   }
   esp_deep_sleep_start();
   ESP.restart(); // will never reach in deep sleep
}

int calculateSleepDuration(int defaultTimeout, bool forceReset, bool getDataOnly) {
   struct timeval now;
   gettimeofday(&now, NULL);

   if (getDataOnly) {
      time_t diff = now.tv_sec - previousWakeup.tv_sec;
      int predictedSleep = defaultTimeout - diff;
      if (predictedSleep < SLEEP_RECALCULATION_PERIOD_SECONDS || predictedSleep <= 0) {
         predictedSleep = defaultTimeout;
      }
      Serial.printf("[SLEEP] Return predicted sleep data only: %d \n", predictedSleep);

      return predictedSleep;
   }

   if (systemData.wakeupCause == wakeup_reason_t::TIMER) {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] no manual wakeup (timer) - using full wakeup period...\n");
      previousWakeup = now;
      return defaultTimeout;
   }
   if (systemData.wakeupCause == wakeup_reason_t::BUTTON) {
      // TODO: cloud time feedback is needed here to calculate new wakeup
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] button wakeup - not able to calculate new sleep internally...\n");
      previousWakeup = now;
      return defaultTimeout;
   }
   if (forceReset) {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] force reset - using full wakeup period...\n");
      previousWakeup = now;
      return defaultTimeout;
   }

   if (previousWakeup.tv_sec > now.tv_sec) {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] detected invalid previous wakeup, resetting...\n");
      previousWakeup = timeval{
          .tv_sec = 0,
          .tv_usec = 0};
   }

   time_t diff = now.tv_sec - previousWakeup.tv_sec;

   if (diff <= 0) {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] detected non positive sleep difference, resetting...\n");
      previousWakeup = now;
      diff = 0;
   }

   Serial.printf("[SLEEP] current time: %lld, previous time: %lld, difference: %lld\n", now.tv_sec, previousWakeup.tv_sec, diff);
   int predictedSleep = defaultTimeout - diff;
   // if the user refreshes less than one minute before the actual refresh will occur, skip that next refresh and use the current one instead.
   if (predictedSleep < SLEEP_RECALCULATION_PERIOD_SECONDS || predictedSleep <= 0) {
      Serial.printf("[SLEEP] manual reset within %d seconds of wakeup window. Reset to full window next\n", SLEEP_RECALCULATION_PERIOD_SECONDS);
      previousWakeup = now;
      return defaultTimeout;
   }

   return predictedSleep;
}

wakeup_reason_t getWakeupReason() {
   int resetReason0 = rtc_get_reset_reason(0);
   int resetReason1 = rtc_get_reset_reason(1);
   int wakeupReason = esp_sleep_get_wakeup_cause();
#if DEBUG
   Serial.printf("[WAKE] Reset Reason 0: %d\n", resetReason0);
   Serial.printf("[WAKE] Reset Reason 1: %d\n", resetReason1);
   Serial.printf("[WAKE] Wake Reason: %d\n", wakeupReason);
#endif
   if (wakeupReason == esp_sleep_wakeup_cause_t::ESP_SLEEP_WAKEUP_UNDEFINED && resetReason0 == 1 && resetReason1 == 1) {
      Serial.printf("[WAKE] Got Button Wakeup or Power Loss Wakeup\n");
      return wakeup_reason_t::BUTTON;
   }
   if (wakeupReason == esp_sleep_wakeup_cause_t::ESP_SLEEP_WAKEUP_EXT1) {
      Serial.printf("[WAKE] Got Motion Wakeup\n");
      return wakeup_reason_t::MOTION;
   }
   if (wakeupReason == esp_sleep_wakeup_cause_t::ESP_SLEEP_WAKEUP_TIMER) {
      Serial.printf("[WAKE] Got Timer Wakeup \n");
      return wakeup_reason_t::TIMER;
   }
   Serial.printf("[WAKE] Got Button System Reset or Others\n");
   return wakeup_reason_t::SYSTEM_RESET;
}

bool usbInit() {
   Wire.beginTransmission(USBC_ADDR);
   Wire.write(0x01);
   Wire.endTransmission(true); // end write operation, as we just wanted to select the starting register

   Wire.requestFrom(USBC_ADDR, 1); // request 6 bytes from peripheral device #8
   char c = Wire.read();           // receive a byte as character
   if (c == 0b00010000) {
      Serial.println("[USB] init OK");
      return true;
   }
   else {
      Serial.println("[USB] init FAIL");
      return false;
   }
}

bool usbCheckConnect() {
   Wire.beginTransmission(USBC_ADDR);
   Wire.write(0x11);
   Wire.endTransmission(true); // end write operation, as we just wanted to select the starting register

   Wire.requestFrom(USBC_ADDR, 1); // request 6 bytes from peripheral device #8
   char c = Wire.read();           // receive a byte as character
   char usbPower = (c >> 3) & 0x01;
   char usbPowerLow = (c >> 6) & 0x01;
   if (usbPower && !usbPowerLow) {
      return true;
   }
   else {
      return false;
   }
}

int accInit(bool skipInit) {
   int orientation = 0;
   if (!skipInit) {
      if (myIMU.begin(6.25, 2, false) == IMU_SUCCESS) {
         if (DEBUG_FLAG)
            Serial.println("[ACC] initialized.");
      }
      else {
         Serial.println("[ACC] Failed to initialize.");
         return -1;
         // while (true);  // stop running sketch if failed
      }

      uint8_t readData = 0;

// Get the ID:
#if DEBUG
      if (myIMU.readRegister(&readData, KXTJ3_WHO_AM_I) ==
          IMU_SUCCESS) {
      }
      else {
         Serial.println("[ACC] Communication error, stopping.");
         return -1;
         // while (true);  // stop running sketch if failed
      }
#endif
   }
   myIMU.standby(false);

   uint8_t dataLowRes = 0;
   int acc_x = 0;
   int acc_y = 0;
   int acc_z = 0;
   bool sampleValid = true;

   if (myIMU.readRegister(&dataLowRes, KXTJ3_XOUT_H) ==
       IMU_SUCCESS) {
      // Read accelerometer data in mg as Float
      float acc_x_loc = myIMU.axisAccel(X);
      acc_x = round((int)(acc_x_loc * 10));
   }
   else {
      sampleValid = false;
   }

   if (myIMU.readRegister(&dataLowRes, KXTJ3_YOUT_H) ==
       IMU_SUCCESS) {
      // Read accelerometer data in mg as Float
      float acc_y_loc = myIMU.axisAccel(Y);
      acc_y = round((int)(acc_y_loc * 10));
   }
   else {
      sampleValid = false;
   }

   if (myIMU.readRegister(&dataLowRes, KXTJ3_ZOUT_H) ==
       IMU_SUCCESS) {
      // Read accelerometer data in mg as Float
      float acc_z_loc = myIMU.axisAccel(Z);
      acc_z = round((int)(acc_z_loc * 10));
   }
   else {
      sampleValid = false;
   }

   if (acc_x > 5 && acc_y < 5 && acc_y > -5) {
      orientation = 0;
   }
   if (acc_x < 5 && acc_x > -5 && acc_y > 5) {
      orientation = 1;
   }
   if (acc_x < -5 && acc_y < 5 && acc_y > -5) {
      orientation = 2;
   }
   if (acc_x < 5 && acc_x > -5 && acc_y < -5) {
      orientation = 3;
   }

   if (DEBUG_FLAG && !skipInit)
      Serial.printf("[ACC] Values: X:%d Y:%d Z:%d Orient: %d \n", acc_x, acc_y, acc_z, orientation);

   // Put IMU back into standby
   myIMU.resetInterrupt();
   myIMU.standby(true);
   return sampleValid ? orientation : -1;
}

bool accIntSet(int sensity) {
   pinMode(INT_PIN, INPUT);
   if (sensity == 0) {
      myIMU.resetInterrupt();
      myIMU.standby(true);
      return true;
   }
   myIMU.resetInterrupt();
   delay(1);
   myIMU.intConf(sensity, 3, 10, HIGH, -1, true, false, true, false, true);
   delay(1);
   return true;
}

void recheckAccOrient(int setOrientValue) {
   if (stopAccRecheck || isEpaperActive() || !settings.autoRotation || bleFile || fwUpdateInProgress)
      return;
   int accCheck = accInit(true);
   if (accCheck >= 0 && accCheck != readIntFromFlash(220)) {
      isOrientUpdate = true;
      systemData.deviceOrientation = accCheck;
      Serial.printf("[ACC] Update Orient to Mem: %d \n", systemData.deviceOrientation);
      writeIntToFlash(systemData.deviceOrientation, 220);
      // writeIntToFlash(0, 150);  // Reset picture version after ota to init update
      if (systemData.deviceOrientation == 2 || systemData.deviceOrientation == 3) {
         displaySetRotation(1);
      }
      else {
         displaySetRotation(0);
      }
   }
}

void checkOrientationInBackground(int setOrientValue, bool isRunning) {
   if (isRunning) {
      stopAccRecheck = false;
      Serial.printf("[ACC] Background update start\n");

      periodicAccCheck.attach_ms(1000, recheckAccOrient, setOrientValue);
   }
   else {
      Serial.printf("[ACC] Background update stop\n");
      stopAccRecheck = true;
      periodicAccCheck.detach();
      return;
   }

   return;
}

bool chargeMode(bool enable) {
   // on  = enable pin released (input), the hold is lifted
   // off = enable pin driven low and held, so it stays low through deep sleep
   bool chargeState = false;
   bool isCharging = false;
   pinMode(CHG_STAT_PIN, INPUT);
   delay(1);
   if (enable) {
      pinMode(CHG_EN_PIN, INPUT);
      gpio_hold_dis((gpio_num_t)CHG_EN_PIN);
      delay(5);
      chargeState = digitalRead(CHG_STAT_PIN);
      if (chargeState == LOW) {
         Serial.println("[CHARGE] on - Charger ON");
         isCharging = true;
      }
      else {
         Serial.println("[CHARGE] on - Charger DONE");
         isCharging = false;
      }
   }
   else {
      digitalWrite(CHG_EN_PIN, LOW);
      pinMode(CHG_EN_PIN, OUTPUT);
      digitalWrite(CHG_EN_PIN, LOW);
      gpio_hold_dis((gpio_num_t)CHG_EN_PIN); // renew an older hold
      gpio_hold_en((gpio_num_t)CHG_EN_PIN);  // keeps the level while the chip sleeps
      Serial.println("[CHARGE] off - Charge OFF");
   }
   systemData.charging = isCharging;
   return isCharging;
}

bool resetAll(bool resetWifi) {
   checkOrientationInBackground(0, false);
   Serial.printf("[MAIN] Reset - WIFI %d \n", resetWifi);
   writeIntToFlash(0, 220);          // restore screen orient to default
   storeSleepTimeMem(DEFAULT_SLEEP); // restore sleep mem store to default
   if (SerialFlash.exists("tmp.bmp")) {
      SerialFlashFile f = SerialFlash.open("tmp.bmp");
      discardFlashSlot(f);
   }
   settings.downloadUrl = "";
   settings.lastModified = "";
   settings.settingsLastModified = "";
   settings.imageMode = 1;
   settings.timeout = DEFAULT_SLEEP;
   settings.httpAuthUser = "";
   settings.httpAuthPassword = "";
   settings.chargerMode = false; // after a reset the charger is off until the user switches it on again
   chargeMode(false);
   if (resetWifi) {
      writeStringToFlash("", 0);  // storing ssid at address 0
      writeStringToFlash("", 40); // storing pss at address 40
      wifiSettings.ssid = "";
      wifiSettings.pss = "";
      wifiSettings.wifiRetries = 0;
      EepromClear();
   }
   saveSettingsToFlash(EEPROM_SETTINGS_ADR);
   return true;
}

void startupCounter(int reset) {
   preferences.begin("my-app", false);
   unsigned int counter = preferences.getUInt("counter", 0);
   counter++;
   if (reset || counter > 16) {
      if (StartCounter >= 5) {
         Serial.println("[MAIN] +5 button presses");
         StartCounter = 0;
         counter = 0;
         preferences.putUInt("counter", counter);
         preferences.end();
         resetAll(true);
         ESP.restart();
         return;
      }
      StartCounter = 0;
      counter = 0;
      Serial.println("[MAIN] Startup Counter RESET");
   }
   preferences.putUInt("counter", counter);
   preferences.end();
   StartCounter = counter;
   if (reset == 0)
      tickerStatupCounter.once_ms(3000, startupCounter, 1);
   return;
}

// inputs: nopicture,turnon,updatepicture,wifiactivate,deviceactivate
void updateDisplayAsyncFunction(int functionNumber) {
   epaperIsUpdating = true;
   if (functionNumber == 1) {
      powerSupplyDisplay(true);
      displaySetText("Connect via Bluetooth", false, true);
   }
   if (functionNumber == 2) {
   }
   if (functionNumber == 3) {
   }
   if (functionNumber == 4) {
   }
   if (functionNumber == 5) {
   }

   epaperIsUpdating = false;
   return;
}

bool updateDisplayAsync(String functionName) {
   int functionNumber = 0;
   if (functionName == "connect_bt") {
      functionNumber = 1;
   }
   if (functionName == "") {
      functionNumber = 2;
   }
   if (functionName == "") {
      functionNumber = 3;
   }
   if (functionName == "") {
      functionNumber = 4;
   }
   if (functionName == "") {
      functionNumber = 5;
   }

   if (epaperIsUpdating || functionNumber < 1) {
      return false;
   }
   onceDisplay.once_ms(100, updateDisplayAsyncFunction, functionNumber);
   return true;
}

// Logs the CRC32 of the display payload stored in a flash slot, so the HIL
// testbench can compare the on-device dithering result against a reference.
void logImageSlotCrc(const char *name) {
   if (!DEBUG_FLAG)
      return;
   prepareSpiBusForFlash();
   SerialFlashFile f = SerialFlash.open(name);
   const uint32_t payloadLen = (EPD_WIDTH * EPD_HEIGHT / 2);
   const uint32_t scratchSize = 4096;
   uint8_t *scratch = (uint8_t *)malloc(scratchSize);
   uint32_t crc = 0;
   if (f && scratch != nullptr && verifyFlashSlotCrc(f, payloadLen, scratch, scratchSize, crc)) {
      Serial.printf("[IMAGE] Slot CRC: 0x%08X (%s, %u bytes)\n", crc, name, payloadLen);
   }
   else {
      Serial.printf("[IMAGE] Slot CRC: unavailable (%s)\n", name);
   }
   free(scratch);
   if (f)
      f.close();
}

static uint8_t displayContent() {
   return EEPROM.read(EEPROM_DISPLAY_CONTENT_ADR);
}

static void setDisplayContent(uint8_t content) {
   if (EEPROM.read(EEPROM_DISPLAY_CONTENT_ADR) != content) {
      EEPROM.write(EEPROM_DISPLAY_CONTENT_ADR, content);
      EEPROM.commit();
   }
}

int showStoredImage(const String &fileName) {
   const int result = setImageFromFS(fileName);
   if (result == 0)
      setDisplayContent(DISPLAY_PICTURE);
   return result;
}

static void showNotice(uint8_t content, const char *text, const char *text2 = "") {
   if (displayContent() == content && !settings.forceDownload) {
      Serial.println("[EPD] Notice is already on the display, not drawn again.");
      return;
   }
   displaySetText(text, false, true, text2);
   setDisplayContent(content);
}

void runSetupMode() {
   Serial.println("[MAIN] Setup Mode Triggered");
   prepareSpiBusForFlash();

   unsigned long setupModeStart = millis();
   unsigned long bleConnectedTime = 0;
   bool bleWasConnected = false;
   bool initialWifiCheckDone = false;

   // Wait for completion, disconnect, or timeout
   while (true) {
      bool isBleTransferActive = (bool)bleFile || fwUpdateInProgress;

      if (!isBleTransferActive && wifiScanRequested) {
         wifiScanRequested = false;
         Serial.println("[NETWORK] WiFi Scan requested via BLE, starting...");
         WiFi.mode(WIFI_STA);
         delay(1);
         int n = WiFi.scanNetworks();
         String wifiSsidScan = "";
         if (n == 0) {
            Serial.println("[NETWORK] no networks found");
         }
         else {
            Serial.printf("[NETWORK] %d networks found\n", n);
            for (int i = 0; i < n; ++i) {
               String entry = WiFi.SSID(i) + "´" + String(WiFi.RSSI(i)) + "´´";
               // a characteristic holds at most 512 bytes: a longer value would not be set at all
               if (wifiSsidScan.length() + entry.length() > 490) {
                  wifiSsidScan = wifiSsidScan + "´...´...´";
                  break;
               }
               wifiSsidScan = wifiSsidScan + entry;
            }
         }
         if (wifiScanCharacteristic) {
            wifiScanCharacteristic->setValue(wifiSsidScan.c_str());
            wifiScanCharacteristic->notify();
         }
         Serial.println("[NETWORK] Scan completed and notified.");
      }

      if (pServer->getConnectedCount() > 0) {
         if (!bleWasConnected) {
            bleWasConnected = true;
            bleConnectedTime = millis();
         }
         if (isBleTransferActive) {
            bleConnectedTime = millis();
         }
         else if (!initialWifiCheckDone && wifiSettings.ssid.length() > 0 && (millis() - bleConnectedTime > 8000)) {
            initialWifiCheckDone = true;
            wifiSettings.isDeployWifi = true;
         }
      }
      else {
         bleWasConnected = false;
      }

      if (!isBleTransferActive && wifiSettings.isDeployWifi) {
         wifiSettings.wifiIsConnected = false;
         wifiSettings.wifiOnboardingFailed = false;
         wifiSettings.isDeployWifi = false;

         if (wifiSettings.bleInitOk && wifiConnectedCharacteristic) {
            uint8_t val = 0;
            wifiConnectedCharacteristic->setValue(&val, 1);
            wifiConnectedCharacteristic->notify();

            if (wifiInfoCharacteristic) {
               wifiInfoCharacteristic->setValue(String("{}").c_str());
               wifiInfoCharacteristic->notify();
            }
         }

         Serial.println("[MAIN] Connecting WiFi...");
         WiFi.disconnect(true);
         delay(100);
         WiFi.mode(WIFI_STA);
         delay(100);

         WiFi.begin(wifiSettings.ssid.c_str(), wifiSettings.pss.c_str());

         unsigned long startWait = millis();
         while (WiFi.status() != WL_CONNECTED && millis() - startWait < 10000) {
            delay(100);
         }

         if (WiFi.status() == WL_CONNECTED) {
            Serial.println("[WIFI] Connected successfully!");
            // check valid wifi connection
            writeStringToFlash(wifiSettings.ssid.c_str(), 0, MAX_WIFI_SSID_LEN);
            writeStringToFlash(wifiSettings.pss.c_str(), 40, MAX_WIFI_PASS_LEN);
         }
         else {
            Serial.println("[WIFI] Connection timeout!");
         }
      }

      if (applyPending) {
         applyInProgress = true;
         applyPending = false;
         bleImageApplied = true;
         Serial.println("[MAIN] Applying new image within setup mode...");
         powerSupplyDisplay(true);
         if (settings.autoRotation) {
            accUpdateOrient();
         }
         logImageSlotCrc("tmp.bmp");
         showStoredImage("tmp.bmp");
         applyInProgress = false;
      }

      if (fwRebootPending && (millis() - fwRebootScheduledAt >= 1200)) {
         fwRebootPending = false;
         Serial.println("[BLE] Rebooting now (firmware update or factory reset)...");
         Serial.flush();
         delay(50);
         ESP.restart();
      }

      if (!isBleTransferActive)
         checkSerialBootloaderCommand();

      if (forceExitSetup) {
         Serial.println("[MAIN] Manual exit requested via Web UI. Switching to fetch/refresh mode.");
         break;
      }

      if (!isBleClientConnected) {
         if (millis() - lastDisconnectTime > SETUP_MODE_TIMEOUT * 1000) {
            Serial.printf("[MAIN] No BLE connection for %ds. Switching to fetch/refresh mode.\n", SETUP_MODE_TIMEOUT);
            break;
         }
      }
      else {
         lastDisconnectTime = millis(); // Reset timer while connected
      }

      const unsigned long lastActivity = bleLastActivity; // read before millis(): it changes in the BLE task
      if (isBleClientConnected && !isBleTransferActive && !fwRebootPending && !systemData.usbConnected &&
          millis() - lastActivity > SETUP_IDLE_TIMEOUT * 1000UL) {
         Serial.printf("[MAIN] BLE client idle for %d s on battery power. Leaving setup mode.\n", SETUP_IDLE_TIMEOUT);
         if (systemInfoCharacteristic) {
            systemInfoCharacteristic->setValue(systemInfoJson(systemData.charging, true).c_str());
            systemInfoCharacteristic->notify();
         }
         delay(500);
         break;
      }

      static unsigned long lastTelemetryUpdate = 0;
      if (!isBleTransferActive && millis() - lastTelemetryUpdate > 10000) {
         lastTelemetryUpdate = millis();
         systemData.usbConnected = usbCheckConnect();
         systemData.vddValue = readVDD(false);
         bool isCharging = false;
         if (settings.chargerMode) {
            isCharging = chargeMode(settings.chargerMode);
         }

         if (systemInfoCharacteristic) {
            systemInfoCharacteristic->setValue(systemInfoJson(isCharging).c_str());
            if (pServer->getConnectedCount() > 0) {
               systemInfoCharacteristic->notify();
            }
         }
      }

      delay(100);
   }
}

// Connects to the stored WiFi. A failed attempt is not repeated in the same wake-up.
bool ensureWifi() {
   static bool failed = false;
   if (WiFi.status() == WL_CONNECTED)
      return true;
   if (failed || wifiSettings.ssid.length() == 0)
      return false;
   WiFi.begin(wifiSettings.ssid.c_str(), wifiSettings.pss.c_str());
   for (int i = 0; WiFi.status() != WL_CONNECTED && i < WIFI_CONNECT_TIMEOUT * 10; i++) {
      delay(100);
   }
   failed = WiFi.status() != WL_CONNECTED;
   return !failed;
}

int processHttpDownload(String fileName) {
   int dlSuccess = 0;
   if (ensureWifi()) {
      dlSuccess = loadImageFromWeb(settings.downloadUrl, "tmp_raw.bin");
      if (dlSuccess == 0) {
         if (processImageFile("tmp_raw.bin", fileName.c_str())) {
            dlSuccess = 0;
         }
         else {
            Serial.println("[IMAGE] Failed to process image file");
            dlSuccess = -1;
         }
      }
      WiFi.setSleep(true);
   }
   else {
      Serial.println("[DL] WiFi Connection Failed");
      dlSuccess = -1;
   }
   return dlSuccess;
}

void initFirstBoot(void) {
   // First Boot Check
   if (EEPROM.read(499) != 42) {
      Serial.println("[MEM] First boot detected, applying default settings.");
      EepromClear();
      settings.timeout = 3600;
      settings.showBatteryWarning = true;
      settings.showWifiWarning = true;
      settings.sleepDisabled = false;
      settings.imageMode = 1;
      settings.motionWakeup = false;
      settings.chargerMode = false;
      settings.settingsUrl = "";
      settings.settingsLastModified = "";
      settings.downloadUrl = "";
      settings.httpAuthUser = "";
      settings.httpAuthPassword = "";
      settings.lastModified = "";

      storeSleepTimeMem(3600);
      saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      EEPROM.write(499, 42);
      EEPROM.commit();
   }
}

// Collects an HTTP body up to a size limit (target of HTTPClient::writeToStream()).
class LimitedBody : public Stream
{
 public:
   explicit LimitedBody(size_t maxLength) : limit(maxLength) {}
   size_t write(uint8_t c) override { return write(&c, 1); }
   size_t write(const uint8_t *data, size_t len) override {
      if (text.length() + len > limit) {
         overflow = true;
         return 0;
      }
      return text.concat((const char *)data, len) ? len : 0;
   }
   int available() override { return 0; }
   int read() override { return -1; }
   int peek() override { return -1; }

   String text;
   bool overflow = false;

 private:
   size_t limit;
};

void fetchRemoteSettings() {
   if (settings.settingsUrl.length() == 0)
      return;
   if (WiFi.status() != WL_CONNECTED)
      return;

   Serial.println("[HTTP] Fetching remote JSON settings...");
   // The login belongs to the server of the picture: it is only sent if the settings file is
   // on that server as well (same protocol, host and port).
   const String settingsOrigin = urlOrigin(settings.settingsUrl);
   const bool sendAuth = settings.httpAuthUser.length() > 0 && settingsOrigin.length() > 0 &&
                         settingsOrigin == urlOrigin(settings.downloadUrl);
   const String url = getRedirect(settings.settingsUrl, sendAuth);

   WiFiClientSecure secureClient;
   secureClient.setInsecure();
   HTTPClient http;
   http.setTimeout(10000);
   http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
   if (url.startsWith("https:")) {
      http.begin(secureClient, url);
   }
   else {
      http.begin(url);
   }
   if (sendAuth) {
      http.setAuthorization(settings.httpAuthUser.c_str(), settings.httpAuthPassword.c_str());
   }
   if (settings.settingsLastModified.length() > 0) {
      if (settings.settingsLastModified.startsWith("etag:"))
         http.addHeader("If-None-Match", settings.settingsLastModified.substring(5));
      else
         http.addHeader("If-Modified-Since", settings.settingsLastModified);
   }

   const char *headerKeys[] = {"Last-Modified", "ETag"};
   http.collectHeaders(headerKeys, 2);
   addTelemetryHeaders(http);

   int httpCode = http.GET();
   if (httpCode == HTTP_CODE_OK) {
      LimitedBody body(MAX_SETTINGS_JSON_SIZE);
      const bool tooLarge = http.getSize() > MAX_SETTINGS_JSON_SIZE;
      const int received = tooLarge ? 0 : http.writeToStream(&body);
      if (tooLarge || body.overflow) {
         Serial.printf("[HTTP] Settings JSON is larger than %d bytes, ignored.\n", MAX_SETTINGS_JSON_SIZE);
         http.end();
         return;
      }
      if (received < 0) {
         Serial.printf("[HTTP] Reading the settings JSON failed: %s\n", http.errorToString(received).c_str());
         http.end();
         return;
      }
      JsonDocument doc;
      DeserializationError error = deserializeJson(doc, body.text);
      if (!error) {
         bool changed = false;

         if (doc["timeout"].is<int>()) {
            int newTimeout = doc["timeout"];
            if (newTimeout >= MIN_SLEEP_TIMEOUT && newTimeout <= MAX_SLEEP_TIMEOUT) {
               settings.timeout = newTimeout;
               changed = true;
               // sleepPrediction was already computed in setup() with the old timeout
               systemData.newSleepTimeSet = false;
               storeSleepTimeMem(settings.timeout);
               if (systemData.newSleepTimeSet)
                  systemData.sleepPrediction = calculateSleepDuration(settings.timeout, true, false);
            }
         }
         if (doc["motionWakeup"].is<bool>()) {
            settings.motionWakeup = doc["motionWakeup"];
            changed = true;
         }
         if (doc["chargerMode"].is<bool>()) {
            // Only switched off from here. Switching it on needs the confirmation in the web UI
            // that rechargeable batteries are inserted.
            if (!doc["chargerMode"].as<bool>()) {
               settings.chargerMode = false;
               changed = true;
            }
            else if (!settings.chargerMode) {
               Serial.println("[HTTP] chargerMode: true ignored, switch it on over Bluetooth.");
            }
         }
         if (doc["autoRotation"].is<bool>()) {
            settings.autoRotation = doc["autoRotation"];
            changed = true;
         }
         if (doc["downloadUrl"].is<String>()) {
            String newDownloadUrl = doc["downloadUrl"].as<String>();
            if (newDownloadUrl.length() > MAX_SETTING_STRING_LEN) {
               Serial.println("[HTTP] ERROR: downloadUrl too long, ignored.");
            }
            else {
               if (newDownloadUrl != settings.downloadUrl) {
                  settings.downloadUrl = newDownloadUrl;
                  settings.lastModified = "";
               }
               changed = true;
               // Same rule as for a URL written over BLE: an empty URL does not switch a frame
               // that shows a picture sent over Bluetooth to the (then failing) download.
               if (newDownloadUrl.length() > 0)
                  settings.imageMode = 1;
            }
         }
         if (doc["httpAuthUser"].is<String>()) {
            String v = doc["httpAuthUser"].as<String>();
            if (v.length() <= MAX_SETTING_STRING_LEN) {
               settings.httpAuthUser = v;
               changed = true;
            }
         }
         if (doc["httpAuthPassword"].is<String>()) {
            String v = doc["httpAuthPassword"].as<String>();
            if (v.length() <= MAX_SETTING_STRING_LEN) {
               settings.httpAuthPassword = v;
               changed = true;
            }
         }

         // validator for the next request, ETag preferred (as for the picture)
         String etag = http.header("ETag");
         etag.trim();
         String lastMod = http.header("Last-Modified");
         lastMod.trim();
         String validator = (etag.length() > 0) ? ("etag:" + etag) : lastMod;
         if (validator.length() > MAX_SETTING_STRING_LEN) {
            validator = (lastMod.length() <= MAX_SETTING_STRING_LEN) ? lastMod : String("");
         }
         if (validator != settings.settingsLastModified) {
            settings.settingsLastModified = validator;
            changed = true;
         }

         if (changed) {
            Serial.println("[HTTP] JSON settings applied and saved.");
            saveSettingsToFlash(EEPROM_SETTINGS_ADR);
         }
      }
      else {
         Serial.println("[HTTP] JSON parse failed");
      }
   }
   else if (httpCode == HTTP_CODE_NOT_MODIFIED) {
      Serial.println("[HTTP] JSON settings not modified.");
   }
   else {
      Serial.printf("[HTTP] GET failed, error: %s\n", http.errorToString(httpCode).c_str());
   }
   http.end();
}

void accUpdateOrient() {
   systemData.deviceOrientation = accInit();
   if (systemData.deviceOrientation == 2 || systemData.deviceOrientation == 3) {
      displaySetRotation(1);
   }
   else {
      displaySetRotation(0);
   }
   return;
}

void test() {
   // adcAttachPin(14);  // Any pin that is ADC capable
   ledBlink(0, false);
   char charBuffer[128];
   pinMode(INT_PIN, OUTPUT);
   digitalWrite(INT_PIN, LOW);
   Serial.println("[DEBUG] Test Function");
   ledBlink(200, false);

   powerSupplyDisplay(true);
   setImageFromFS("tmp_raw.bin");
   while (true) {
   }
   // displayWipe(false);

   // displaySetText("Connect via Bluetooth", false, true);
   delay(5000);
   gotToDeepSleep(0, true, false);

   int timeout;
   timeout = calculateSleepDuration(DEFAULT_SLEEP, false, false);
   Serial.printf("time to next update: %d\n", timeout);
   while (true) {
      float temperature = temperatureRead();
      Serial.printf("Temp onBoard = %.2f °C\n", temperature);
      // bool testCharge = chargeMode(false);
      systemData.vddValue = readVDD(false);
      Serial.printf("VDD: %d mV\n", systemData.vddValue);
      delay(5000);
   };
   gotToDeepSleep(60, false, true);

   // display.powerOff();
   //  BleInit(CLIENT_ID, true);
}

void setup() {
   chargeMode(false); // charger off until the stored setting is known
   powerSupplyDisplay(false);
   pinMode(BAT_VOLT_EN_PIN, OUTPUT);
#ifdef EPD_TYPE_13INCH
   digitalWrite(BAT_VOLT_EN_PIN, HIGH);
#else
   digitalWrite(BAT_VOLT_EN_PIN, LOW);
#endif
   Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
   pinMode(LED_PIN, OUTPUT);
   digitalWrite(LED_PIN, LOW);
   Serial.begin(115200);
   Serial.println("[MAIN] test mode check..."); // flashers wait for this line, then send 'B'
   analogReadResolution(12);
   systemData.usbConnected = usbCheckConnect();
   delay(80);

   systemData.vddValue = readVDD(false);
   checkSerialBootloaderCommand();
   if (!systemData.usbConnected && systemData.vddValue < BAT_OFF_VALUE) {
      if (DEBUG_FLAG)
         Serial.printf("[MAIN] Bat low protection: %dmV\n", systemData.vddValue);
      analogWrite(LED_PIN, LED_DIM_VALUE);
      // Empty rechargeable batteries must be able to charge when USB is plugged in while the
      // frame sleeps: take the charger setting from the memory (off unless the user switched it on).
      bool drawNotice = false;
      if (EepromInit(EEPROM_SIZE)) {
         settings.chargerMode = storedChargerMode();
         // The display says once that the batteries are empty (see loop()). After that, and
         // with an empty memory, the frame only sleeps.
         drawNotice = EEPROM.read(499) == 42 && readIntFromFlash(EEPROM_SETTINGS_ADR + 5) != 0 &&
                      displayContent() != DISPLAY_BATTERY_EMPTY;
      }
      if (!drawNotice)
         gotToDeepSleep(86000, false, false);
      batteryEmpty = true;
   }
   systemData.wakeupCause = getWakeupReason();
   tickerFailsave.once_ms(FAILSAVE_TIMER * 1000, timeoutFailsafe, 0);

   if (systemData.wakeupCause == wakeup_reason_t::BUTTON) {
      buttonWake = true;
      startupCounter(false);
   }

   EepromInit(EEPROM_SIZE);
   // pinMode(DISP_POWER, INPUT); // USB TEST PINS TODO: only paper 7
   pinMode(INT_PIN, INPUT);
   pinMode(BUSY_PIN, INPUT);
   pinMode(RST_PIN, OUTPUT);
   pinMode(CS_EPD_PIN, OUTPUT);
   pinMode(EPD_CS_S, OUTPUT);
   pinMode(CS_SD_PIN, OUTPUT);
   pinMode(SCK_PIN, OUTPUT);
   pinMode(MOSI_PIN, OUTPUT);
   digitalWrite(CS_EPD_PIN, HIGH);
   digitalWrite(EPD_CS_S, HIGH);
   digitalWrite(CS_SD_PIN, HIGH);

   gpio_set_drive_capability((gpio_num_t)SCK_PIN, GPIO_DRIVE_CAP_1);
   gpio_set_drive_capability((gpio_num_t)MOSI_PIN, GPIO_DRIVE_CAP_1);
   initFirstBoot();

   // Load credentials & settings from EEPROM
   restoreSettingsToFlash(EEPROM_SETTINGS_ADR);
   displaySetOverlayOption(DEVICE_INFO_STRING, true);
   displaySetRotation(0);
   // myEsp32FOTA removed
   char firmwareVersion[] = SOFTWARE_VERSION;

   ledBlink(500, true);
   Serial.begin(115200);
   sleep(1);

   Serial.printf("[MAIN] INIT Device V: %s\n", firmwareVersion);
   Serial.println("[MAIN] FW: offline"); // lets tools tell this firmware apart from the cloud firmware
   const esp_partition_t *runningApp = esp_ota_get_running_partition();
   Serial.printf("[MAIN] App slot: %s\n", runningApp ? runningApp->label : "unknown"); // app0 or app1
   if (DEBUG_FLAG)
      Serial.printf("[MAIN] Current counter value: %u VDD: %d\n", StartCounter, systemData.vddValue);
   if (!SPIFFS.begin(false)) {
      Serial.println("[MEM] SPIFFS initialisation failed!");
   }
   if (StartCounter >= 2) {
      settings.forceDownload = true;
      settings.skipSetupMode = true;
   }
   WiFi.onEvent(WiFiEvent);
   WiFi.mode(WIFI_STA);

   SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN); // SCK(), MISO(),MOSI(), SS()
   SPI.setFrequency(DISPLAY_SPI_SPEED);
   SerialFlash.begin(CS_FLASH_PIN, DISPLAY_SPI_SPEED); // proceed even if begin() fails
   powerSupplyDisplay(true);
   prepareSpiBusForFlash();
   SerialFlash.begin(CS_FLASH_PIN, FLASH_SPI_SPEED); // proceed even if begin() fails
   initEpaperDisplay(SPI);
   powerSupplyDisplay(false);
   chargeMode(settings.chargerMode);

   setDeviceUid();
   setDisplayData(CLIENT_ID, systemData.vddValue);
   // TODO: maybe do a function to generally check updated mem values
   float temperature = temperatureRead();
   if (DEBUG_FLAG)
      Serial.printf("[MAIN] Temp Main: %.2f °C\n", temperature);
   if (temperature < 21.0) {
      Serial.printf("[MAIN] Low Temp detected: %.2f °C - disable quick refresh\n", temperature);
      displaySetQuickRefresh(false);
   }

#if DEBUG
   // test(); //-----------------test---------please remove
#endif

   if (buttonWake && !settings.skipSetupMode && !batteryEmpty) {
      tickerFailsave.detach();
      BleInit(CLIENT_ID, true);
      // updateDisplayAsync("connect_bt");
      runSetupMode();
      if (fwRebootPending) {
         // a restart was requested just as the setup mode ended
         Serial.flush();
         ESP.restart();
      }

      Serial.println("[MAIN] Setup Mode Completed or Timeout");
      BleInit(CLIENT_ID, false); // Stop BLE advertising to save memory
      // Always proceed to loop to fetch URL or refresh picture
      downloadStart = true;
      delay(200);
      tickerFailsave.once_ms(FAILSAVE_TIMER * 1000, timeoutFailsafe, 0);
   }
   else {
      Serial.println("[MAIN] skip setup Mode");
   }

   ledBlink(500, true);
   saveSettingsToFlash(EEPROM_SETTINGS_ADR);
   storeSleepTimeMem(settings.timeout);

   systemData.sleepPrediction = calculateSleepDuration(settings.timeout, systemData.newSleepTimeSet, false);

   if (SPIFFS.usedBytes() > 10000) {
      Serial.println("[MEM] SPIFFS seems to full ...");
   }

   delay(10);
}

static int retryDelaySeconds(uint8_t failures, int regularSleep) {
   if (failures <= 1)
      return constrain(regularSleep, 60, 300);
   if (failures == 2)
      return 900;
   if (failures == 3)
      return 3600;
   return max(settings.timeout, 3600);
}

void loop() {

   if (downloadStart) {
      BleInit(CLIENT_ID, false);
      powerSupplyDisplay(true);
      downloadStart = false;
      if (settings.autoRotation) {
         accUpdateOrient();
         checkOrientationInBackground(systemData.deviceOrientation, true);
      }
      else {
         systemData.deviceOrientation = accInit(); // only reported to the server, the picture is not rotated
      }

      if (batteryEmpty) {
         // Remembered before it is drawn: if the voltage breaks down during the refresh, the
         // frame must not try again and again.
         setDisplayContent(DISPLAY_BATTERY_EMPTY);
         if (settings.lastModified.length() > 0) {
            settings.lastModified = ""; // with new batteries the picture is drawn again, also if it has not changed
            saveSettingsToFlash(EEPROM_SETTINGS_ADR);
         }
         displaySetText("Battery empty - please replace or recharge", false);
         gotToDeepSleep(86000, false, false);
      }

      delay(200);
      String fileName = "tmp.bmp";
      int dlSuccess = 0;

      // Fallback: If in BLE mode but the file is missing and we have a download URL configured, switch to URL mode
      if (settings.imageMode == 0 && !hasValidFlashImage(fileName.c_str()) && settings.downloadUrl.length() > 0) {
         Serial.println("[IMAGE] BLE mode active but tmp.bmp is missing. Fallback to URL mode.");
         settings.imageMode = 1;
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }

      if (settings.settingsUrl.length() > 0 && ensureWifi()) {
         fetchRemoteSettings(); // This might change imageMode or downloadUrl!
      }

      const bool canDownload = wifiSettings.ssid.length() > 0 && settings.downloadUrl.length() > 0;
      const bool hasPicture = hasValidFlashImage(fileName.c_str());
      if ((settings.imageMode == 1 && !canDownload) || (settings.imageMode == 0 && !hasPicture)) {
         Serial.println("[MAIN] Not set up: nothing to download and no picture sent over Bluetooth.");
         if (!hasPicture) { // a stored picture stays on the display
            showNotice(DISPLAY_SETUP_HINT, "Not set up: press button, connect via Bluetooth",
                       "paperlesspaper.github.io/paperlesspaper-firmware-offline");
         }

         const bool pollSettings = settings.imageMode == 1 && wifiSettings.ssid.length() > 0 && settings.settingsUrl.length() > 0;
         const int regularSleep = (settings.timeout > 0) ? systemData.sleepPrediction : DEFAULT_SLEEP;
         gotToDeepSleep(pollSettings ? max(60, regularSleep) : 0, false, false);
      }

      if (settings.imageMode == 1) { // URL Mode
         dlSuccess = processHttpDownload(fileName);
      }
      else { // BLE Mode (Mode 0)
         Serial.println("[IMAGE] Using BLE uncompressed tmp.bmp");
      }

      waitDisplayComplete(false);
      delay(25);

      int setSuccess = 0;
      if (dlSuccess == 0 || dlSuccess == 1) { // 0 = downloaded/ok, 1 = not modified
         if (settings.imageMode == 0 && bleImageApplied) {
            Serial.println("[IMAGE] Image was already applied during setup mode, skipping refresh.");
            setSuccess = 0;
         }
         else if (dlSuccess == 0 || settings.imageMode == 0) {
            WiFi.disconnect(true);
            logImageSlotCrc(fileName.c_str());
            setSuccess = showStoredImage(fileName);
            if (setSuccess == 0 && dlSuccess == 0 && settings.imageMode == 1) {
               if (settings.lastModified != tempLastModified) {
                  settings.lastModified = tempLastModified;
                  saveSettingsToFlash(EEPROM_SETTINGS_ADR);
               }
               tempLastModified = "";
            }
         }
         else {
            Serial.println("[IMAGE] Not rendering, image not modified");
            setSuccess = 0;
         }
      }
      else {
         showNotice(DISPLAY_ERROR_TEXT, "Error: Picture download failed, please try again");
         setSuccess = -1;
         // The error text has replaced the picture. Forget the validator of the stored picture:
         // otherwise the next successful request is answered with "not modified" (HTTP 304),
         // nothing is drawn and the error text stays on the display.
         if (settings.lastModified.length() > 0) {
            settings.lastModified = "";
            saveSettingsToFlash(EEPROM_SETTINGS_ADR);
         }
      }

      debugFS();
      Serial.println("[MAIN] End of Update");
      if (settings.imageMode == 0) {
         gotToDeepSleep(0, false, false);
      }
      bool doMotionWake = (settings.imageMode == 1) ? settings.motionWakeup : false;
      int nextSleep = (settings.timeout > 0) ? systemData.sleepPrediction : DEFAULT_SLEEP;
      if (settings.imageMode == 1 && (dlSuccess < 0 || setSuccess < 0)) {
         if (failedUpdates < 255)
            failedUpdates++;
         nextSleep = retryDelaySeconds(failedUpdates, nextSleep);
         Serial.printf("[SLEEP] Update failed %u time(s) in a row; retry in %d seconds\n", failedUpdates, nextSleep);
      }
      else {
         failedUpdates = 0;
         if (settings.imageMode == 1 && serverSleepSeconds > 0) {
            int elapsed = (millis() - serverSleepReceivedMs) / 1000;
            nextSleep = max(60, serverSleepSeconds - elapsed);
            Serial.printf("[SLEEP] Server-directed wake in %d seconds\n", nextSleep);
         }
      }
      gotToDeepSleep(nextSleep, false, doMotionWake);
   }

   // Keep alive for setup mode / BLE configs
   delay(500);
}