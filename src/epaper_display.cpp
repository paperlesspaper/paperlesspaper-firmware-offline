#include "epaper_display.h"
#include <Arduino.h>
#include <SerialFlash.h>
#include "image_storage.h"
#include "image_format.h"
#include "epaper_13inch_transfer.h"
#include <WiFi.h>
#include <qrcode.h>

// Externs from main.cpp
extern SerialFlashFile saveFile;

DisplayInfo displayInfos = {
    .version = false,
    .batteryInfo = false,
    .batteryLowBig = false,
    .wifiSignal = false,
    .deviceInfoString = false,
    .wifiOfflineBig = false};

DisplaySettings displaySettings = {
    .rotationText = 3,
    .rotationPicture = 2,
    .quickRefresh = true,
    .globalQuickRefreshDisable = false,
#ifdef EPD_TYPE_13INCH
    .displayQuickRefreshTime = 2500,
    .displayQuickRefreshWipeTime = 2000,
    .colorWhiteFast = GxEPD_BLACK,
    .colorBlackFast = GxEPD_BLUE,
    .colorWipeFast = 1, // blue
#else
    .displayQuickRefreshTime = 960,
    .displayQuickRefreshWipeTime = 960,
    .colorWhiteFast = GxEPD_WHITE_I,
    .colorBlackFast = GxEPD_BLACK_I,
    .colorWipeFast = 1, // blue
#endif
};

QRCode QR;

std::atomic<bool> epaperIsUpdating{false};
static bool needsHibernate = true;
extern bool powerSupplyDisplay(bool enable);
static bool displayIsInit = false;
static SPIClass *epd_spi_bus = nullptr;
static char epd_client_id[20] = {0};
static int epd_vdd_value = 0;

#ifdef EPD_TYPE_13INCH
DisplayType display(GxEPD2_1330c_EL133UF3(/*CS=*/CS_EPD_PIN, /*CS-S=*/EPD_CS_S, /*DC=*/-1, /*RST=*/RST_PIN, BUSY_PIN));
#else
DisplayType display(GxEPD2_730c_GDEP073E01(/*CS=*/CS_EPD_PIN, /*DC=*/DC_PIN, /*RST=*/RST_PIN, /*BUSY=*/BUSY_PIN));
#endif

U8G2_FOR_ADAFRUIT_GFX u8g2_for_adafruit_gfx;

void setDisplayData(const char *clientId, int vddValue) {
   DisplayGuard resourceGuard;
   if (clientId) {
      strncpy(epd_client_id, clientId, sizeof(epd_client_id) - 1);
      epd_client_id[sizeof(epd_client_id) - 1] = '\0';
   }
   epd_vdd_value = vddValue;
}

void initEpaperDisplay(SPIClass &spiBus) {
   DisplayGuard resourceGuard;
   epd_spi_bus = &spiBus;
   if (displayIsInit)
      return;
   pinMode(RST_PIN, OUTPUT);
   pinMode(CS_EPD_PIN, OUTPUT);
   pinMode(DC_PIN, OUTPUT);
   pinMode(EPD_CS_S, OUTPUT);
   pinMode(BUSY_PIN, INPUT);
   pinMode(DC_PIN, OUTPUT);
   digitalWrite(EPD_CS_S, HIGH);
   digitalWrite(CS_EPD_PIN, HIGH);
   display.epd2.selectSPI(spiBus, SPISettings(DISPLAY_SPI_SPEED, MSBFIRST, SPI_MODE0));
   u8g2_for_adafruit_gfx.begin(display);
   displayTypeDetect();
   displayIsInit = true;
}

bool isEpaperActive() {
   return epaperIsUpdating;
}

void displayHibernate() {
   DisplayGuard resourceGuard;
   if (needsHibernate) {
      display.hibernate();
      needsHibernate = false;
   }
}

void deinitDisplay() {
   DisplayGuard resourceGuard;
   pinMode(RST_PIN, OUTPUT);
   digitalWrite(RST_PIN, 1);
   delay(50); // needs a little longer
   digitalWrite(RST_PIN, 0);
   delay(20);
   displayIsInit = false;
   displayHibernate();
   pinMode(RST_PIN, INPUT);
   pinMode(CS_EPD_PIN, INPUT);
   pinMode(EPD_CS_S, INPUT);
   pinMode(DC_PIN, INPUT);
}

void displayTypeDetect() {
   DisplayGuard resourceGuard;
   uint8_t reg9A[2] = {0};
   uint8_t patternDKE1[2] = {0x36, 0x42};
   uint8_t patternDKE2[2] = {0x36, 0x36};
   uint8_t patternOKRA1[2] = {0x31, 0xC2};
   uint8_t patternOKRA2[2] = {0x33, 0x00}; // Das zweite Byte wird bei OKRA 2 manchmal nicht gesendet, wir prüfen primär das erste

   display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
   needsHibernate = true;
   display.init(115200);

   epd_spi_bus->endTransaction();

   // Register 0x9A auslesen
   epd_spi_bus->beginTransaction(SPISettings(DISPLAY_SPI_SPEED, MSBFIRST, SPI_MODE0));
   digitalWrite(DC_PIN, LOW);
   digitalWrite(CS_EPD_PIN, LOW);
   epd_spi_bus->transfer(0x9A);
   digitalWrite(DC_PIN, HIGH);

   for (int i = 0; i < 2; i++) {
      reg9A[i] = epd_spi_bus->transfer(0x00);
   }
   digitalWrite(CS_EPD_PIN, HIGH);
   epd_spi_bus->endTransaction();

#ifdef USE_QUICK_REFRESH

   // Pattern Matching
   if (memcmp(reg9A, patternDKE1, 2) == 0 || memcmp(reg9A, patternDKE2, 2) == 0) {
      Serial.println("[EPD] Match Found: DKE Display");
      displaySettings.displayQuickRefreshTime = 1500;
      displaySettings.displayQuickRefreshWipeTime = 500;
      displaySettings.colorWhiteFast = GxEPD_RED;
      displaySettings.colorBlackFast = GxEPD_BLUE;
      displaySettings.colorWipeFast = 1; // 3
   }
   else if (memcmp(reg9A, patternOKRA1, 2) == 0 || memcmp(reg9A, patternOKRA2, 2) == 0) {
      Serial.println("[EPD] Match Found: OKRA Display");
      displaySettings.displayQuickRefreshTime = 1500; // 1400-1700
      displaySettings.displayQuickRefreshWipeTime = 4000;
      displaySettings.colorWhiteFast = GxEPD_YELLOW;
      displaySettings.colorBlackFast = GxEPD_WHITE;
      displaySettings.colorWipeFast = 1; // blue
   }
   else {
      Serial.println("[EPD] No matching Type.");
      Serial.printf("[EPD] Register 0x9A Read (2 bytes): 0x%02X 0x%02X\n", reg9A[0], reg9A[1]);
      displaySettings.globalQuickRefreshDisable = true;
   }

#else
   Serial.printf("[EPD] Register 0x9A Read (2 bytes): 0x%02X 0x%02X\n", reg9A[0], reg9A[1]);
   displaySettings.globalQuickRefreshDisable = true;
   displaySettings.quickRefresh = false;

#endif
}

void displaySetOverlayOption(DisplayInfoKey key, bool value) {
   DisplayGuard resourceGuard;
   switch (key) {
   case DisplayInfoKey::VERSION:
      displayInfos.version = value;
      break;
   case DisplayInfoKey::BATTERY_INFO:
      displayInfos.batteryInfo = value;
      break;
   case DisplayInfoKey::BATTERY_LOW_BIG:
      displayInfos.batteryLowBig = value;
      break;
   case DisplayInfoKey::WIFI_SIGNAL:
      displayInfos.wifiSignal = value;
      break;
   case DisplayInfoKey::DEVICE_INFO_STRING:
      displayInfos.deviceInfoString = value;
      break;
   case DisplayInfoKey::WIFI_OFFLINE_BIG:
      displayInfos.wifiOfflineBig = value;
      break;
   }
}

void displayOverlays(DisplayType &display, DisplayInfo displayData, bool invertColors, bool fullcolor) {
   DisplayGuard resourceGuard;
   int16_t tw = 0;
   int foreGround = GxEPD_WHITE_I;
   int backGround = GxEPD_BLACK_I;
   if (fullcolor) {
      foreGround = GxEPD_WHITE;
      backGround = GxEPD_BLACK;
   }
   if (invertColors) {
      // invert again
      int tempStore = foreGround;
      foreGround = backGround;
      backGround = tempStore;
   }
   char charBuffer[128];
   char charBuffer2[128];
   int pos = 0;

   if (displayData.deviceInfoString) {
      int deviceIdPos = 20;

      u8g2_for_adafruit_gfx.setForegroundColor(backGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(foreGround); // apply Adafruit GFX color

      sprintf(charBuffer, "ID: %s", epd_client_id);
      String wifiSSID = WiFi.SSID();
      if (wifiSSID.length() > 1) {
         sprintf(charBuffer2, "%s WiFi: %s", charBuffer, wifiSSID.c_str());
         sprintf(charBuffer, "%s", charBuffer2);
      }
      else {
         sprintf(charBuffer2, "%s WiFi: NOT SET", charBuffer);
         sprintf(charBuffer, "%s", charBuffer2);
      }

      u8g2_for_adafruit_gfx.setFont(FONT_INFO);                                        // extended font
      tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer);                             // text box width
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, EPD_WIDTH - deviceIdPos); // start writing at this position
      u8g2_for_adafruit_gfx.print(charBuffer);
   }

   if (displayData.batteryLowBig) {
      int batteryLowPos = 500;

      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setFont(FONT_BIG);              // extended font
      u8g2_for_adafruit_gfx.setFontMode(1);                 // use u8g2 transparent mode (this is default)

      sprintf(charBuffer, "BATTERY LOW");
      int16_t tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer);                                  // text box width
      int16_t ta = u8g2_for_adafruit_gfx.getFontAscent();                                           // positive
      int16_t td = u8g2_for_adafruit_gfx.getFontDescent();                                          // negative; in mathematicians view
      int16_t th = ta - td;                                                                         // text box height
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, (EPD_WIDTH + batteryLowPos - th) / 2); // start writing at this position
      display.fillRect((EPD_HEIGHT - tw) / 2 - 2, (EPD_WIDTH + batteryLowPos - th) / 2 - 20, tw + 5, 25, backGround);
      u8g2_for_adafruit_gfx.print(charBuffer);
   }

   // Version Display bottom right
   if (displayData.version) {
      u8g2_for_adafruit_gfx.setFont(FONT_VERSION);          // extended font
      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color

      sprintf(charBuffer, "%s", SOFTWARE_VERSION);
#if DEBUG
      sprintf(charBuffer2, "DEV: %s", charBuffer);
      sprintf(charBuffer, "%s", charBuffer2);
#endif
      tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer); // text box width
      display.fillRect(EPD_HEIGHT - tw - 2 - pos, EPD_WIDTH - 7, tw + 3, 8, backGround);
      u8g2_for_adafruit_gfx.setCursor(EPD_HEIGHT - tw - 1 - pos, EPD_WIDTH - 1);
      u8g2_for_adafruit_gfx.print(charBuffer);
      pos = pos + 60;
   }
   if (displayData.batteryInfo) {
      u8g2_for_adafruit_gfx.setFont(FONT_VERSION);          // extended font
      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color
      int tempVdd = epd_vdd_value;

      sprintf(charBuffer, "Bat: %dV", tempVdd);

      tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer); // text box width
      display.fillRect(EPD_HEIGHT - tw - 2 - pos, EPD_WIDTH - 7, tw + 3, 8, backGround);
      u8g2_for_adafruit_gfx.setCursor(EPD_HEIGHT - tw - 1 - pos, EPD_WIDTH - 1);
      u8g2_for_adafruit_gfx.print(charBuffer);
      pos = pos + 60;
   }

   if (displayData.wifiSignal) {
      u8g2_for_adafruit_gfx.setFont(FONT_VERSION);          // extended font
      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color
      int wifiSignal = WiFi.RSSI();

      sprintf(charBuffer, "WiFi Sig: %d", wifiSignal);
      tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer); // text box width
      display.fillRect(EPD_HEIGHT - tw - 2 - pos, EPD_WIDTH - 7, tw + 3, 8, backGround);
      u8g2_for_adafruit_gfx.setCursor(EPD_HEIGHT - tw - 1 - pos, EPD_WIDTH - 1);
      u8g2_for_adafruit_gfx.print(charBuffer);
      pos = pos + 60;
   }
}

int setImageFromFS_7inch(String fileName) {
   DisplayGuard resourceGuard;
   epaperIsUpdating = true;
   saveFile = SerialFlash.open(fileName.c_str());
   if (!saveFile) {
      Serial.println("[BMP] File missing");
      return -1;
   }

   uint16_t width = EPD_WIDTH;
   uint16_t height = EPD_HEIGHT;
   int offsetData = 0;

   // Check if the file is a standard BMP (starts with 'BM')
   uint8_t magic[2];
   if (saveFile.read(magic, 2) == 2) {
      if (magic[0] == 'B' && magic[1] == 'M') {
         // It's a standard BMP file. Read the pixel data offset at byte 0x0A
         saveFile.seek(0x0A);
         uint32_t bmpOffset = 0;
         saveFile.read((uint8_t *)&bmpOffset, 4);
         offsetData = bmpOffset;
         Serial.printf("[BMP] Detected Windows BMP. Pixel Data starts at offset: %d\n", offsetData);
      }
      else {
         Serial.println("[BMP] Detected RAW payload (no BM magic). Reading from byte 0.");
      }
   }

   Serial.printf("[BMP] Loading Image H: %d W: %d\n", height, width);

   if (width > EPD_WIDTH || height > EPD_HEIGHT) {
      Serial.printf("[BMP] Image too wide or tall!");
      return -1;
   }

   display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
   needsHibernate = true;
   display.init(115200);
   display.setRotation(displaySettings.rotationPicture);
   display.setFullWindow();
   Serial.print("[EPD] Update Display... \n");

   int bufferSize = width / 2;
   uint8_t *lineBuffer = (uint8_t *)malloc(bufferSize);

   display.firstPage();
   do {
      display.fillScreen(GxEPD_WHITE);
      saveFile.seek(offsetData);

      for (int y = 0; y < height; y++) {
         saveFile.read(lineBuffer, bufferSize);
         for (int x = 0; x < width; x++) {
            uint8_t colorData = lineBuffer[x / 2];
            uint8_t colorNibble = (x % 2 == 0) ? (colorData >> 4) : (colorData & 0x0F);
            if (colorNibble != 6) { // Optimization: display is already filled with WHITE (6)
               display.drawPixel(x, y, getColor(colorNibble));
            }
         }
      }
   }
   while (display.nextPage());

   free(lineBuffer);
   saveFile.close();
   Serial.println("[EPD] End Draw...");
   epaperIsUpdating = false;
   return 0;
}

#ifdef EPD_TYPE_13INCH
namespace {
struct Epd13IO {
   void command(uint8_t half, uint8_t cmd, const uint8_t *data, uint32_t size) {
      epd_spi_bus->beginTransaction(SPISettings(Epd13::SPI_HZ, MSBFIRST, SPI_MODE0));
      digitalWrite(CS_EPD_PIN, half == 1 ? HIGH : LOW);
      digitalWrite(EPD_CS_S, half == 0 ? HIGH : LOW);
      epd_spi_bus->transfer(cmd);
      if (size) epd_spi_bus->writeBytes(data, size);
      digitalWrite(CS_EPD_PIN, HIGH);
      digitalWrite(EPD_CS_S, HIGH);
      epd_spi_bus->endTransaction();
   }
   void yieldBus() { yield(); }
   void halfComplete(uint8_t half, uint32_t bytes) {
      Serial.printf("[EPD] RAM controller=%s complete pixels=%u bytes=%u\n",
                    half ? "slave" : "master", bytes * 2, bytes);
   }
   bool busy() { return digitalRead(BUSY_PIN) == LOW; }
   uint32_t now() { return millis(); }
   void pause(uint32_t ms) { delay(ms); }
   void refreshBegin() {
      Serial.println("[EPD] PANEL REFRESH BEGIN mode=FULL controllers=both DRF=0x12:00 quick=off busy_active_stable_ms=5 busy_idle_stable_ms=20");
   }
   void refreshEnd(uint32_t ms) {
      Serial.printf("[EPD] PANEL REFRESH END busy_seen=1 busy_idle=1 idle_stable_ms=20 elapsed_ms=%u\n", ms);
   }
   void failure(const char *stage) { Serial.printf("[EPD] PANEL REFRESH FAILED stage=%s\n", stage); }
};
}

int setImageFromFS_13inch(String fileName, bool doRefresh) {
   DisplayGuard resourceGuard;
   if (!epd_spi_bus) return -1;
   auto frame = makeDisplayFrame([] {
      serviceOrientation(true); // two matching samples, before any init/reset
      epaperIsUpdating = true;
      Serial.printf("[EPD] V6 orientation frozen rotation=%u\n", displaySettings.rotationPicture);
      return int(displaySettings.rotationPicture);
   }, [] {
      saveFile.close();
      saveFile = SerialFlashFile();
      // Normal POF has already completed on success. On ANY error, cut the
      // physical rail once; do not issue another POF into an uncertain BUSY state.
      digitalWrite(CS_EPD_PIN, HIGH);
      digitalWrite(EPD_CS_S, HIGH);
      digitalWrite(RST_PIN, LOW);
      powerSupplyDisplay(false);
      needsHibernate = false; // later sleep must not call driver powerOff again
      epaperIsUpdating = false;
      Serial.println("[EPD] V6 cleanup complete; orientation released");
      serviceOrientation(true); // current stable orientation after POF/cleanup
   });
   powerSupplyDisplay(true);
   saveFile = SerialFlash.open(fileName.c_str());
   uint32_t length = ImageStorage::logicalLength();
   if (!saveFile || !length) return -1;
   uint8_t header[54];
   if (saveFile.read(header, sizeof(header)) != sizeof(header) || SerialFlash.failed()) return -1;
   uint32_t offset = 0;
   if (header[0] == 'B' && header[1] == 'M') {
      if (!ImageFormat::validBmp4(header, length, Epd13::WIDTH, Epd13::HEIGHT)) return -1;
      offset = ImageFormat::little32(header, 10);
   } else if (length != Epd13::IMAGE_BYTES) return -1; // BLE packed raw frame

   Serial.println("[EPD] Path=EL133UF3 full-image-v6 storage=persistent-slot-v3");
   Serial.printf("[EPD] RAM coverage=FULL 1200x1600 controllers=2x600x1600 transport=strips rows=2 offset=%u\n", offset);
   Serial.println("[EPD] Init=standard Spectra6 vendor registers PSR=DF69 waveform=built-in quick=off spi_hz=10000000");
   display.enableQuickRefresh(0, false);
   display.epd2.selectSPI(*epd_spi_bus, SPISettings(Epd13::SPI_HZ, MSBFIRST, SPI_MODE0));
   display.epd2.init(115200); // explicit normal init, never initAlt or quick reset-stop
   // This driver lazily initializes on a RAM write. clearScreen is RAM-only;
   // it does NOT perform an optical white clear or an extra panel refresh.
   display.clearScreen(0x01);
   Epd13IO io;
   if (!Epd13::waitIdle(io, 120000)) { io.failure("initialization timeout"); return -1; }
   uint32_t written = 0;
   auto read = [&](uint32_t address, uint8_t *data, uint32_t size) {
      saveFile.seek(offset + address);
      return saveFile.read(data, size) == size && !SerialFlash.failed();
   };
   if (!Epd13::writeFrame(io, read, getColor, frame.orientation > 0, written)) {
      Serial.printf("[EPD] RAM transfer FAILED bytes=%u expected=960000; no refresh\n", written);
      return -1;
   }
   Serial.printf("[EPD] RAM coverage=FULL complete pixels=%u bytes=%u (image only; RAM prefill=960000 bytes)\n", written * 2, written);
   if (!doRefresh) {
      Serial.println("[EPD] V6 RAM-only request completed with full refresh for safe ownership");
   }
   Serial.println("[EPD] Refresh=FULL full-window both controllers; single waveform; no optical pre-clear");
   if (!Epd13::refreshFull(io)) return -1;
   Serial.println("[EPD] POF complete; image update successful");
   return 0;
}
#endif

extern bool imageStorageReady;
int setImageFromFS(String fileName, bool doRefresh) {
   DisplayGuard resourceGuard;
   if (!imageStorageReady || SerialFlash.failed() ||
       fileName != ImageStorage::IMAGE_SLOT || !ImageStorage::logicalLength()) return -1;
#ifdef EPD_TYPE_13INCH
   return setImageFromFS_13inch(fileName, doRefresh);
#else
   return setImageFromFS_7inch(fileName);
#endif
}

void displayWipe(bool quick) {
   DisplayGuard resourceGuard;
   powerSupplyDisplay(true);
   if (quick) {
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, true);
      needsHibernate = true;
      display.init(115200);
   }
   else {
      needsHibernate = true;
      display.init(115200);
   }

   display.clearScreen(0x01);
   display.refresh();
}

void displaySetText(String info, bool isBlackboard, bool quickRefresh) {
   DisplayGuard resourceGuard;
   powerSupplyDisplay(true);
   int foreGround = GxEPD_BLACK_I;
   int backGround = GxEPD_WHITE_I;
   bool invert = false;

   if (!displaySettings.quickRefresh) {
      if (isBlackboard) {
         invert = true;
         foreGround = GxEPD_WHITE;
         backGround = GxEPD_BLACK;
      }
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, true);
      needsHibernate = true;
      display.init(115200);
   }
   else {
      if (isBlackboard) {
         invert = true;
         foreGround = GxEPD_WHITE_I;
         backGround = GxEPD_BLACK_I;
      }
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
      needsHibernate = true;
      display.init(115200);
   }

   display.setRotation(displaySettings.rotationText);
   display.firstPage();
   do {
      display.fillScreen(backGround);
      u8g2_for_adafruit_gfx.setFontDirection(0);            // left to right (this is default)
      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color

      u8g2_for_adafruit_gfx.setFont(FONT_BIG); // extended font
      u8g2_for_adafruit_gfx.setFontMode(1);    // use u8g2 transparent mode (this is default)

      int16_t tw = u8g2_for_adafruit_gfx.getUTF8Width(info.c_str());                // text box width
      int16_t ta = u8g2_for_adafruit_gfx.getFontAscent();                           // positive
      int16_t td = u8g2_for_adafruit_gfx.getFontDescent();                          // negative; in mathematicians view
      int16_t th = ta - td;                                                         // text box height
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, (EPD_WIDTH - th) / 2); // start writing at this position

      u8g2_for_adafruit_gfx.print(info);
      if (info.length() > 1) {
         displayInfos.deviceInfoString = true;
      }

      displayOverlays(display, displayInfos, invert, false);
   }
   while (display.nextPage());
}

bool waitDisplayComplete(bool quick) {
   DisplayGuard resourceGuard;
   if (!needsHibernate) return true; // V6 already completed POF or cut the rail
   int counter = 0;
   while (counter < 20) {
      counter++;
      if (quick)
         counter = 21;
      bool pinState = digitalRead(BUSY_PIN);
      if (pinState) {
         return true;
         break;
      }
#if DEBUG
      Serial.println("[EPD] Wait for Display...");
#endif
      delay(500);
   }
   return false;
}

void displayTurnOn() {
   DisplayGuard resourceGuard;
   powerSupplyDisplay(true);
   String info = "Ich schlafe ...";
   String info2 = "Drücke die Taste auf der Rückseite";
   String info3 = "um mich zu wecken.";

   char msg[128];
   sprintf(msg, "%s%s%s", "https://paperlesspaper.de/b?d=", epd_client_id, "&w=99");

   uint8_t QRData[qrcode_getBufferSize(QR_VERSION)];
   uint8_t blockSize;
   uint8_t page = 0;
   qrcode_initText(&QR, QRData, QR_VERSION, ECC_LOW, msg);
   blockSize = 2;
   uint16_t x0 = (EPD_HEIGHT - 30 * blockSize) / 2;
   uint16_t y0 = 680;

   int foreGround = GxEPD_WHITE_I;
   int backGround = GxEPD_BLACK_I;
   bool fullColor = false;

   Serial.print(F("\n[EPD] Press to turn on Screen Loading - "));
   if (displaySettings.quickRefresh) {
      needsHibernate = true;
      display.init(115200);
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, true);
   }
   else {
      display.enableQuickRefresh(0, false);
      needsHibernate = true;
      display.init(115200);
      foreGround = GxEPD_WHITE;
      backGround = GxEPD_BLACK;
      fullColor = true;
   }
   display.setRotation(displaySettings.rotationText);
   display.firstPage();
   // Display 600*448
   do {
      int16_t tw = 0;
      display.fillScreen(backGround);
      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setFontDirection(0);            // left to right (this is default)
      u8g2_for_adafruit_gfx.setFontMode(1);                 // use u8g2 transparent mode (this is default)

      display.fillRect(x0 + 2, y0 + 2, QR.size * blockSize + QR_QUIET_ZONE + blockSize - 2, QR.size * blockSize + QR_QUIET_ZONE + blockSize - 2, foreGround);

      // For each vertical module
      for (uint8_t y = 0; y < QR.size; y++) {
         // For each horizontal module
         for (uint8_t x = 0; x < QR.size; x++) {
            if (qrcode_getModule(&QR, x, y))
               display.fillRect(x0 + (x * blockSize) + QR_QUIET_ZONE,
                                y0 + (y * blockSize) + QR_QUIET_ZONE,
                                blockSize, blockSize,
                                (qrcode_getModule(&QR, x, y)) ? backGround : foreGround);
         }
      }

      u8g2_for_adafruit_gfx.setFont(FONT_MAIN); // extended font
      tw = u8g2_for_adafruit_gfx.getUTF8Width(info.c_str());
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, 300); // start writing at this position
      u8g2_for_adafruit_gfx.print(info);

      u8g2_for_adafruit_gfx.setFont(FONT_BIG);                     // extended font
      tw = u8g2_for_adafruit_gfx.getUTF8Width(info2.c_str());      // text box width
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, 370); // start writing at this position
      u8g2_for_adafruit_gfx.print(info2);                          // UTF-8 string: "<" 550 448 664 ">"

      tw = u8g2_for_adafruit_gfx.getUTF8Width(info3.c_str());      // text box width
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, 395); // start writing at this position
      u8g2_for_adafruit_gfx.print(info3);

      u8g2_for_adafruit_gfx.setFont(FONT_NORMAL);                  // extended font
      tw = u8g2_for_adafruit_gfx.getUTF8Width("I am sleeping..."); // text box width
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, 560); // start writing at this position
      u8g2_for_adafruit_gfx.print("I am sleeping...");

      u8g2_for_adafruit_gfx.setFont(FONT_SMALL);                                              // extended font
      tw = u8g2_for_adafruit_gfx.getUTF8Width("Press the button on the back to wake me up."); // text box width
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, 590);                            // start writing at this position
      u8g2_for_adafruit_gfx.print("Press the button on the back to wake me up.");

      displayOverlays(display, displayInfos, true, fullColor);
   }
   while (display.nextPage());
}

void displaySetRotation(int orientation) {
   DisplayGuard resourceGuard;
   switch (orientation) {
   case 0:
#ifdef EPD_TYPE_13INCH
      displaySettings.rotationText = 0;
      displaySettings.rotationPicture = 0;
#else
      displaySettings.rotationText = 3;
      displaySettings.rotationPicture = 2;
#endif
      break;
   case 1:
#ifdef EPD_TYPE_13INCH
      displaySettings.rotationText = 2;
      displaySettings.rotationPicture = 2;
#else
      displaySettings.rotationText = 1;
      displaySettings.rotationPicture = 0;
#endif
      break;
   default:
#ifdef EPD_TYPE_13INCH
      displaySettings.rotationText = 0;
      displaySettings.rotationPicture = 0;
#else
      displaySettings.rotationText = 3;
      displaySettings.rotationPicture = 2;
#endif
   }
}

void displaySetQuickRefresh(bool enable, int refreshTime, int wipeTime) {
   DisplayGuard resourceGuard;
   if (displaySettings.globalQuickRefreshDisable) {
      displaySettings.quickRefresh = false;
      return;
   }
   if (enable) {
      displaySettings.quickRefresh = true;
   }
   else {
      displaySettings.quickRefresh = false;
   }
   if (refreshTime > 0) {
      displaySettings.displayQuickRefreshTime = refreshTime;
   }
   if (wipeTime > 0) {
      displaySettings.displayQuickRefreshWipeTime = wipeTime;
   }
}

uint16_t getColor(uint8_t color) {
   switch (color) {
   case 0:
#ifdef EPD_TYPE_13INCH
      return 0x00;
#else
      return GxEPD_BLACK;
#endif
   case 1:
#ifdef EPD_TYPE_13INCH
      return 0x05;
#else
      return GxEPD_BLUE;
#endif
   case 2:
#ifdef EPD_TYPE_13INCH
      return 0x06;
#else
      return GxEPD_GREEN;
#endif
   case 3:
#ifdef EPD_TYPE_13INCH
      return 0x03;
#else
      return GxEPD_RED;
#endif
   case 5:
#ifdef EPD_TYPE_13INCH
      return 0x02;
#else
      return GxEPD_YELLOW;
#endif
   case 6:
#ifdef EPD_TYPE_13INCH
      return 0x01;
#else
      return GxEPD_WHITE;
#endif
   default:
#ifdef EPD_TYPE_13INCH
      return 0x01;
#else
      return GxEPD_WHITE;
#endif
   }
}