#include "epaper_display.h"
#include <Arduino.h>
#include "storage.h"
#include "usb_link.h"
#include <WiFi.h>
#include <qrcode.h>

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

bool epaperIsUpdating = false;
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

// init() sets the speed of the serial line: a USB session keeps its own
static void displayInit() {
   display.init(UsbLink::baudRate());
}

void setDisplayData(const char *clientId, int vddValue) {
   if (clientId) {
      strncpy(epd_client_id, clientId, sizeof(epd_client_id) - 1);
      epd_client_id[sizeof(epd_client_id) - 1] = '\0';
   }
   epd_vdd_value = vddValue;
}

void initEpaperDisplay(SPIClass &spiBus) {
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

void deinitDisplay() {
   pinMode(RST_PIN, OUTPUT);
   digitalWrite(RST_PIN, 1);
   delay(50); // needs a little longer
   digitalWrite(RST_PIN, 0);
   delay(20);
   displayIsInit = false;
   display.hibernate();
   pinMode(RST_PIN, INPUT);
   pinMode(CS_EPD_PIN, INPUT);
   pinMode(EPD_CS_S, INPUT);
   pinMode(DC_PIN, INPUT);
}

void displayTypeDetect() {
   uint8_t reg9A[2] = {0};
   uint8_t patternDKE1[2] = {0x36, 0x42};
   uint8_t patternDKE2[2] = {0x36, 0x36};
   uint8_t patternOKRA1[2] = {0x31, 0xC2};
   uint8_t patternOKRA2[2] = {0x33, 0x00}; // Das zweite Byte wird bei OKRA 2 manchmal nicht gesendet, wir prüfen primär das erste

   display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
   displayInit();

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

// Offset of the pixel data in a stored picture: a BMP file or the bare display payload. -1: not usable.
static int storedImageOffset(StoreFile &imageFile) {
   uint8_t magic[2] = {0, 0};
   int offsetData = 0;
   if (!imageFile.seek(0) || imageFile.read(magic, 2) != 2) {
      Serial.println("[BMP] Stored picture is empty");
      return -1;
   }
   if (magic[0] == 'B' && magic[1] == 'M') {
      // It's a standard BMP file. Read the pixel data offset at byte 0x0A
      uint32_t bmpOffset = 0;
      imageFile.seek(0x0A);
      imageFile.read((uint8_t *)&bmpOffset, 4);
      offsetData = bmpOffset;
      Serial.printf("[BMP] Detected Windows BMP. Pixel Data starts at offset: %d\n", offsetData);
   }
   else {
      Serial.println("[BMP] Detected RAW payload (no BM magic). Reading from byte 0.");
   }
   if (offsetData < 0 || imageFile.size() < (uint32_t)offsetData + (EPD_WIDTH * EPD_HEIGHT / 2)) {
      Serial.printf("[BMP] Image invalid or smaller than required payload!\n");
      return -1;
   }
   return offsetData;
}

#ifdef EPD_TYPE_13INCH
// The panel is 1200 x 1600: two controllers side by side, each takes 600 pixels (300 bytes) of a row.
int setImageFromRows(ImageRowRewind rewind, ImageRowReader readRow, void *context, bool doRefresh) {
   epaperIsUpdating = true;
   const int rowBytes = EPD_HEIGHT / 2;
   const int halfBytes = rowBytes / 2;
   const int height = EPD_WIDTH;

   // Rows per block: an even divisor of the height (the window counts in double rows).
   static const int blockSizes[] = {50, 20, 10};
   int blockRows = 0;
   uint8_t *block = nullptr;
   for (int size : blockSizes) {
      block = (uint8_t *)malloc(size * rowBytes);
      if (block) {
         blockRows = size;
         break;
      }
   }
   if (!block) {
      Serial.println("[EPD] Not enough memory to send the picture.");
      epaperIsUpdating = false;
      return -1;
   }

   display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
   displayInit();
   display.epd2.writeImage(nullptr, 0, 0, 0, 0); // an empty area: only sets the controllers up

   Serial.println("[EPD] Streaming Image to Display... ");
   const uint32_t start = millis();
   const bool rotate180 = (displaySettings.rotationPicture > 0);
   bool ok = rewind(context);
   for (int y = 0; y < height && ok; y += blockRows) {
      ok = readRow(context, block, blockRows * rowBytes);
      if (!ok)
         break;

      // colour codes of the picture -> codes of the panel
      for (int i = 0; i < blockRows * rowBytes; i++)
         block[i] = (getColor(block[i] >> 4) << 4) | getColor(block[i] & 0x0F);
      if (rotate180) {
         // every half row backwards, pixel by pixel
         for (uint8_t *half = block; half < block + blockRows * rowBytes; half += halfBytes) {
            for (int a = 0, b = halfBytes - 1; a < b; a++, b--) {
               const uint8_t left = half[a];
               half[a] = (half[b] << 4) | (half[b] >> 4);
               half[b] = (left << 4) | (left >> 4);
            }
         }
      }

      // The window is set per block, so the blocks may come in any order: turned by 180°, the
      // first rows of the picture are the last ones of the panel.
      const int firstRow = rotate180 ? (height - y - blockRows) : y;
      const uint16_t HRED = rowBytes * 2 - 1; // 1199
      const uint16_t VRST = firstRow / 2;
      const uint16_t VRED = (firstRow + blockRows) / 2 - 1;

      SPI.beginTransaction(SPISettings(DISPLAY_SPI_SPEED, MSBFIRST, SPI_MODE0));
      for (int half = 0; half < 2; half++) {
         const int csPin = (half == 0) ? CS_EPD_PIN : EPD_CS_S;
         // PTLW (Partial Window) Command Setting 0x83
         digitalWrite(csPin, LOW);
         SPI.transfer(0x83);
         SPI.transfer(0x00); // HRST
         SPI.transfer(0x00);
         SPI.transfer(HRED >> 8);
         SPI.transfer(HRED & 0xFF);
         SPI.transfer(VRST >> 8);
         SPI.transfer(VRST & 0xFF);
         SPI.transfer(VRED >> 8);
         SPI.transfer(VRED & 0xFF);
         SPI.transfer(0x01); // PTLW_ENABLE
         digitalWrite(csPin, HIGH);
         // PTIN (Partial In) command 0x91
         digitalWrite(csPin, LOW);
         SPI.transfer(0x91);
         digitalWrite(csPin, HIGH);
         // DTM command 0x10
         digitalWrite(csPin, LOW);
         SPI.transfer(0x10);
         const int sourceHalf = rotate180 ? (1 - half) : half;
         for (int i = 0; i < blockRows; i++) {
            const int row = rotate180 ? (blockRows - 1 - i) : i;
            SPI.writeBytes(block + row * rowBytes + sourceHalf * halfBytes, halfBytes);
         }
         digitalWrite(csPin, HIGH);
      }
      SPI.endTransaction();
      delay(1);
   }
   free(block);

   if (!ok) {
      Serial.println("[EPD] Picture not readable, display not refreshed");
      epaperIsUpdating = false;
      return -1;
   }
   Serial.printf("[EPD] Image sent in %u ms. Refreshing now.\n", (unsigned)(millis() - start));

   // PTLW (Partial Window) für beide Controller wieder deaktivieren,
   // damit der nachfolgende Refresh (DRF) den gesamten Bildschirm erfasst!
   SPI.beginTransaction(SPISettings(DISPLAY_SPI_SPEED, MSBFIRST, SPI_MODE0));
   digitalWrite(CS_EPD_PIN, LOW);
   SPI.transfer(0x83);
   for (int i = 0; i < 9; i++)
      SPI.transfer(0x00);
   digitalWrite(CS_EPD_PIN, HIGH);

   digitalWrite(EPD_CS_S, LOW);
   SPI.transfer(0x83);
   for (int i = 0; i < 9; i++)
      SPI.transfer(0x00);
   digitalWrite(EPD_CS_S, HIGH);
   SPI.endTransaction();

   if (doRefresh) {
      display.refresh();
   }
   epaperIsUpdating = false;
   return 0;
}
#else
int setImageFromRows(ImageRowRewind rewind, ImageRowReader readRow, void *context, bool doRefresh) {
   epaperIsUpdating = true;
   const int width = EPD_WIDTH;
   const int height = EPD_HEIGHT;
   const int bufferSize = width / 2;
   uint8_t *lineBuffer = (uint8_t *)malloc(bufferSize);
   if (!lineBuffer) {
      epaperIsUpdating = false;
      return -1;
   }

   display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
   displayInit();
   display.setRotation(displaySettings.rotationPicture);
   display.setFullWindow();
   Serial.print("[EPD] Update Display... \n");

   bool ok = true;
   display.firstPage();
   do {
      display.fillScreen(GxEPD_WHITE);
      ok = rewind(context);
      for (int y = 0; y < height && ok; y++) {
         ok = readRow(context, lineBuffer, bufferSize);
         for (int x = 0; x < width && ok; x++) {
            uint8_t colorData = lineBuffer[x / 2];
            uint8_t colorNibble = (x % 2 == 0) ? (colorData >> 4) : (colorData & 0x0F);
            if (colorNibble != 6) { // Optimization: display is already filled with WHITE (6)
               display.drawPixel(x, y, getColor(colorNibble));
            }
         }
      }
      if (!ok)
         break; // nothing is refreshed: the picture on the display stays
   }
   while (display.nextPage());

   free(lineBuffer);
   if (!ok) {
      Serial.println("[EPD] Picture not readable, display not refreshed");
      display.powerOff();
   }
   Serial.println("[EPD] End Draw...");
   epaperIsUpdating = false;
   return ok ? 0 : -1;
}
#endif

struct StoredRows
{
   StoreFile *file;
   uint32_t offset;
};

static bool storedRowsRewind(void *context) {
   StoredRows *rows = (StoredRows *)context;
   return rows->file->seek(rows->offset);
}

static bool storedRowsRead(void *context, uint8_t *row, int len) {
   return ((StoredRows *)context)->file->read(row, len) == (uint32_t)len;
}

int setImageFromFS(String fileName, bool doRefresh) {
   int result = -1;
   StoreFile imageFile;
   if (!imageFile.openRead(fileName.c_str())) {
      Serial.println("[BMP] File missing");
   }
   else {
      const int offsetData = storedImageOffset(imageFile);
      if (offsetData >= 0) {
         Serial.printf("[BMP] Loading Image H: %d W: %d\n", EPD_HEIGHT, EPD_WIDTH);
         StoredRows rows = {&imageFile, (uint32_t)offsetData};
         result = setImageFromRows(storedRowsRewind, storedRowsRead, &rows, doRefresh);
      }
   }
   // Stable marker line for the HIL testbench (0 = image shown, <0 = error)
   Serial.printf("[EPD] Set Image Done: %d\n", result);
   return result;
}

void displayWipe(bool quick) {
   if (quick) {
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, true);
      displayInit();
   }
   else {
      displayInit();
   }

   display.clearScreen(0x01);
   display.refresh();
}

void displaySetText(String info, bool isBlackboard, bool quickRefresh, String info2) {
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
      displayInit();
   }
   else {
      if (isBlackboard) {
         invert = true;
         foreGround = GxEPD_WHITE_I;
         backGround = GxEPD_BLACK_I;
      }
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
      displayInit();
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
      if (info2.length() > 0) {
         u8g2_for_adafruit_gfx.setFont(FONT_SMALL);
         int16_t tw2 = u8g2_for_adafruit_gfx.getUTF8Width(info2.c_str());
         int16_t th2 = u8g2_for_adafruit_gfx.getFontAscent() - u8g2_for_adafruit_gfx.getFontDescent();
         u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw2) / 2, (EPD_WIDTH - th) / 2 + th2 + 12);
         u8g2_for_adafruit_gfx.print(info2);
      }

      displayOverlays(display, displayInfos, invert, false);
   }
   while (display.nextPage());
}

bool waitDisplayComplete(bool quick) {
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
      displayInit();
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, true);
   }
   else {
      display.enableQuickRefresh(0, false);
      displayInit();
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