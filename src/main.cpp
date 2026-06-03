#include <FS.h>
#include <HTTPClient.h>
#include <WiFi.h>
#define DEST_FS_USES_SPIFFS
#include <Arduino.h>
#include <ArduinoJson.h>
#include <GxEPD2_7C.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
// #include <SD_MMC.h>
#include <SPI.h>
#include <SerialFlash.h>
#include <U8g2_for_Adafruit_GFX.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp32fota.h>
#include <rom/rtc.h>

#include "Adafruit_GFX.h"
#include "EEPROM.h"
#include "SPIFFS.h"
#include "Ticker.h"
#include "driver/rtc_io.h"
#include "kxtj3-1057.h"

#define DEBUG 1

#if DEBUG
#define PRINTS(s)         \
   do                     \
   {                      \
      Serial.print(F(s)); \
   } while (false)
#define PRINT(s, v)       \
   do                     \
   {                      \
      Serial.print(F(s)); \
      Serial.print(v);    \
   } while (false)
#else
#define PRINTS(s)
#define PRINT(s, v)
#endif

#ifdef ARDUHAL_LOG_LEVEL
#undef ARDUHAL_LOG_LEVEL
#define ARDUHAL_LOG_LEVEL ARDUHAL_LOG_LEVEL_NONE
#endif
#define BUTTON_PIN_BITMASK(GPIO) (1ULL << GPIO) // 2 ^ GPIO_NUMBER in hex

// E-Paper Pins
#define BUSY_PIN 18
#define RST_PIN 1
#define DC_PIN 19
#define CS_EPD_PIN 20

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

#define EPD_WIDTH 800
#define EPD_HEIGHT 480

#define uS_TO_S_FACTOR 1000000ULL   /* Conversion factor for micro seconds to seconds */
#define LENGTH(x) (strlen(x) + 1)   // length of char string
#define EEPROM_SIZE 1024            // EEPROM size
#define EEPROM_SETTINGS_ADR 500     // start address to store settings
#define SOFTWARE_VERSION "0.0.0"    // Software version
#define EPD_TYPE_IDENTIFIER "epd7-" // Type of device (screen type)

#ifndef ENV_OTA_URL
#define ENV_OTA_URL ""
#endif

#ifndef ENV_WIFI_PW_DEPLOY
#define ENV_WIFI_PW_DEPLOY ""
#endif

#ifndef ENV_WIFI_SSID_DEPLOY
#define ENV_WIFI_SSID_DEPLOY ""
#endif

#define OTA_URL ENV_OTA_URL
#define DEFAULT_WIFI_PW ENV_WIFI_PW_DEPLOY
#define DEFAULT_WIFI_SSID ENV_WIFI_SSID_DEPLOY
#define DEFAULT_SLEEP 3600         // Default time how long to sleep after update
#define FAILSAVE_TIMER 180         // Time to shutdown the device if no reaction or hangup
#define VDD_CORRECTION_FACTOR 2.30 // factor to get real VDD voltage from measured value
#define SLEEP_RECALCULATION_PERIOD_SECONDS 30
#define SETUP_MODE_TIMEOUT 30 // seconds to wait in setup mode for BLE connection before switching to fetch/refresh mode

#if DEBUG
const bool DEBUG_FLAG = true;
#else
const bool DEBUG_FLAG = false;
#endif

#define FONT_MAIN u8g2_font_helvB24_tf // Font for main text
#define FONT_BIG u8g2_font_helvB14_tf  // Font for big text
#define FONT_INFO u8g2_font_7x14_tf
#define FONT_VERSION u8g2_font_tom_thumb_4x6_tf

typedef enum
{
   SYSTEM_RESET = 0,
   BUTTON = 1,
   MOTION = 2,
   TIMER = 3,
} wakeup_reason_t;

struct wifiSettings
{
   String ssid; // string variable to store ssid
   String pss;  // string variable to store password
   int wifiQuality;
   uint8_t wifiRetries;
   bool wifiIsConnected;
   bool wifiOnboardingFailed;
   bool bleInitOk;
   bool isDeployWifi;
   String clientId;
} wifiSettings = {
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

// display extra infos on top of all screens
struct displayInfo
{
   bool version;
   bool batteryInfo;
   bool batteryLowBig;
   bool wifiSignal;
   bool deviceInfoString;
   bool wifiOfflineBig;
} displayInfos = {
    .version = false,
    .batteryInfo = false,
    .batteryLowBig = false,
    .wifiSignal = false,
    .deviceInfoString = false,
    .wifiOfflineBig = false};

struct displaySettings
{
   uint8_t rotationText;
   uint8_t rotationPicture;
   bool quickRefresh;
   int displayQuickRefreshTime;
} displaySettings = {
    .rotationText = 3,
    .rotationPicture = 2,
    .quickRefresh = true,
    .displayQuickRefreshTime = 960};

// settings set via Web BLE
struct settings
{
   int timeout;      // Seconds to Sleep after update done
   String lut;       // Color Settings for EPD
   bool clearscreen; // if clear screen before update
   bool showBatteryWarning;
   bool showWifiWarning;
   bool sleepDisabled;
   String downloadUrl;
   String httpAuthUser;
   String httpAuthPassword;
   String lastModified;
   int imageMode;
} settings = {.timeout = DEFAULT_SLEEP, .lut = "default", .clearscreen = true, .showBatteryWarning = true, .showWifiWarning = true, .sleepDisabled = false, .downloadUrl = "", .httpAuthUser = "", .httpAuthPassword = "", .lastModified = "", .imageMode = 1};

// system read data
struct systemData
{
   wakeup_reason_t wakeupCause;
   int vddValue;
   int sleepPrediction;
   bool newSleepTimeSet;
   bool usbConnected;
   int deviceOrientation;
} systemData = {
    .wakeupCause = SYSTEM_RESET,
    .vddValue = 5000,
    .sleepPrediction = DEFAULT_SLEEP,
    .newSleepTimeSet = false,
    .usbConnected = true,
    .deviceOrientation = 0};

esp_sleep_wakeup_cause_t wakeup_reason;
using DisplayType = GxEPD2_7C<GxEPD2_730c_GDEP073E01, GxEPD2_730c_GDEP073E01::HEIGHT / 4>;
DisplayType display(GxEPD2_730c_GDEP073E01(/*CS=*/CS_EPD_PIN, /*DC=*/DC_PIN, /*RST=*/RST_PIN, /*BUSY=*/BUSY_PIN)); // Waveshare 5.65" 7-color
KXTJ3 myIMU(ACC_ADDR);                                                                                             // Address can be 0x0E or 0x0F
esp32FOTA myEsp32FOTA("esp32-fota-http", SOFTWARE_VERSION);
WiFiClientSecure net = WiFiClientSecure();
Preferences preferences;
U8G2_FOR_ADAFRUIT_GFX u8g2_for_adafruit_gfx;
Ticker tickerFailsave;
Ticker perdiodicLed;
Ticker perdiodicLedOff;
Ticker periodicAccCheck;
Ticker tickerStatupCounter;
SerialFlashFile saveFile;
RTC_DATA_ATTR timeval previousWakeup = timeval{.tv_sec = 0, .tv_usec = 0};

NimBLECharacteristic *wifiConnectedCharacteristic;
NimBLECharacteristic *wifiInfoCharacteristic;
NimBLEAdvertising *pAdvertising;
static NimBLEServer *pServer;

struct dataLayout
{
   int integer;
   char byte[4];
};

const uint8_t QR_VERSION = 3;    // QR Code Version
const uint8_t QR_QUIET_ZONE = 4; // quiet zone all around

int httpFileSize = 0;
int StartCounter = 0;

bool downloadStart = true;
char CLIENT_ID[20];
bool periodicLedIsOn = false;
int periodicLedTimeout = 0;
bool epaperIsUpdating = false;
bool buttonWake = false; // true if wakeup via reset button
bool setupModeComplete = false;
bool stopAccRecheck = false;
SerialFlashFile bleFile;
uint32_t bleBytesReceived = 0;

#define BLE_BUFFER_SIZE 4080
uint8_t bleWriteBuffer[BLE_BUFFER_SIZE];
uint16_t bleWriteBufferPos = 0;

void ledBlink(int timeout, bool on);
void debugFS(void);
bool BleInit(String deviceId, bool enable);
void writeIntToFlash(int value, int startAddr);
int storeSleepTimeMem(int updateTime = 0);
void gotToDeepSleep(int seconds, bool showScreen = true, bool motionWake = true);
void displayOverlays(DisplayType &display, displayInfo displayData, bool invertColors, bool fullcolor = false);
int setImageFromFS(String fileName);
void displayWipe(bool quick);
void displaySetText(String info, bool blackBoard, bool quickRefresh = true);
bool waitDisplayComplete(bool quick);
int accInit(bool skipInit = false);
bool accIntSet(int sensity);
void checkOrientationInBackground(int setOrientValue, bool isRunning = true);
bool chargeMode(bool enable);
bool usbInit();
bool usbCheckConnect();
int calculateSleepDuration(int defaultTimeout, bool forceReset, bool getDataOnly = false);
bool resetAll(bool resetWifi);
wakeup_reason_t getWakeupReason();

void WiFiEvent(WiFiEvent_t event)
{
   if (DEBUG_FLAG)
      // Serial.printf("[WiFi-event] event: %d\n", event);

      switch (event)
      {
      case ARDUINO_EVENT_WIFI_STA_GOT_IP:
         if (DEBUG_FLAG)
            Serial.println("[NETWORK] WiFi connected");
         Serial.printf("[NETWORK] IP address: ");
         Serial.println(WiFi.localIP());

         if (wifiSettings.wifiIsConnected != true)
         {
            wifiSettings.wifiIsConnected = true;
            if (wifiSettings.bleInitOk)
            {
               uint8_t val = 1;
               wifiConnectedCharacteristic->setValue(&val, 1);
               wifiConnectedCharacteristic->notify();

               if (wifiInfoCharacteristic)
               {
                  JsonDocument doc;
                  doc["ip"] = WiFi.localIP().toString();
                  doc["rssi"] = WiFi.RSSI();
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
         if (wifiSettings.wifiIsConnected != false)
         {
            wifiSettings.wifiIsConnected = false;
            if (wifiSettings.bleInitOk)
            {
               uint8_t val = 0;
               wifiConnectedCharacteristic->setValue(&val, 1);
               wifiConnectedCharacteristic->notify();

               if (wifiInfoCharacteristic)
               {
                  wifiInfoCharacteristic->setValue("{}");
                  wifiInfoCharacteristic->notify();
               }
            }
         }
         break;
      }
}

void timeoutFailsave(int time)
{
   Serial.println("printing in once function.");

   gotToDeepSleep(DEFAULT_SLEEP, true, false);
}

void ledBlinkFunctionOff()
{
   digitalWrite(LED_PIN, LOW);
   perdiodicLedOff.detach();
}

void ledBlinkFunction()
{
   digitalWrite(LED_PIN, HIGH);
   perdiodicLedOff.attach_ms(periodicLedTimeout * 0.2, ledBlinkFunctionOff);
}

// set blink with timeout in ms
void ledBlink(int timeout, bool on)
{
   if (on)
   {
      if (timeout <= 0)
      {
         perdiodicLed.detach();
         perdiodicLedOff.detach();
         digitalWrite(LED_PIN, HIGH);
         return;
      }
      periodicLedIsOn = true;
      periodicLedTimeout = timeout * 2;
      perdiodicLed.attach_ms(periodicLedTimeout, ledBlinkFunction);
   }
   else
   {
      perdiodicLed.detach();
      perdiodicLedOff.detach();
      digitalWrite(LED_PIN, LOW);
      delay(periodicLedTimeout * 0.3);
      digitalWrite(LED_PIN, LOW);
      periodicLedIsOn = false;
   }
}

int readVDD(bool singleReading)
{
   pinMode(BAT_VOLT_EN_PIN, OUTPUT);
   pinMode(BAT_VOLT_SENSE_PIN, INPUT);
   digitalWrite(BAT_VOLT_EN_PIN, LOW);
   delay(3);
   int retries = 1;
   if (!singleReading)
   {
      retries = 5;
   }
   float rawValue = 0;
   int count = 0;
   for (size_t i = 0; i < retries; i++)
   {
      float readValue = analogRead(BAT_VOLT_SENSE_PIN);
      delayMicroseconds(18000);
      rawValue += readValue;
      count++;
   }
   if (count > 0)
   {
      rawValue = rawValue / count;
   }
   pinMode(BAT_VOLT_EN_PIN, INPUT);
   return int(round(rawValue * VDD_CORRECTION_FACTOR));
}

bool EepromInit(int size)
{
   if (!EEPROM.begin(size))
   { // Init EEPROM
      Serial.println("[MEM] failed to init EEPROM");
      delay(1000);
      return false;
   }
   else
   {
      Serial.println("[MEM] EEPROM init OK");
      return true;
   }
}

void writeStringToFlash(const char *toStore, int startAddr)
{
   int i = 0;
   for (; i < LENGTH(toStore); i++)
   {
      EEPROM.write(startAddr + i, toStore[i]);
   }
   EEPROM.write(startAddr + i, '\0');
   EEPROM.commit();
}

String readStringFromFlash(int startAddr)
{
   char in[129];
   int i = 0;
   for (; i < 128; i++)
   {
      char c = EEPROM.read(startAddr + i);
      if (c == '\0' || c == (char)0xFF)
      {
         break;
      }
      in[i] = c;
   }
   in[i] = '\0';

   return String(in);
}

int readIntFromFlash(int addr)
{
   dataLayout data3;
   EEPROM.get(addr, data3);
   return data3.integer;
}

void writeIntToFlash(int value, int startAddr)
{
   dataLayout data2;
   data2.integer = value;
   EEPROM.put(startAddr, data2);
   EEPROM.commit();
}

void saveSettingsToFlash(int startAddr)
{
   writeIntToFlash(settings.clearscreen, startAddr);
   writeIntToFlash(settings.showBatteryWarning, startAddr + 5);
   writeIntToFlash(settings.showWifiWarning, startAddr + 10);
   writeIntToFlash(settings.sleepDisabled, startAddr + 15);
   writeIntToFlash(settings.imageMode, startAddr + 20);
   writeStringToFlash(settings.downloadUrl.c_str(), startAddr + 25);
   writeStringToFlash(settings.lastModified.c_str(), startAddr + 155);
   writeStringToFlash(settings.httpAuthUser.c_str(), startAddr + 285);
   writeStringToFlash(settings.httpAuthPassword.c_str(), startAddr + 415);
   Serial.println("[MEM] Settings saved to EEPROM");
}

void restoreSettingsToFlash(int startAddr)
{
   settings.clearscreen = readIntFromFlash(startAddr);
   settings.showBatteryWarning = readIntFromFlash(startAddr + 5);
   settings.showWifiWarning = readIntFromFlash(startAddr + 10);
   settings.sleepDisabled = readIntFromFlash(startAddr + 15);
   settings.imageMode = readIntFromFlash(startAddr + 20);
   settings.downloadUrl = readStringFromFlash(startAddr + 25);
   settings.lastModified = readStringFromFlash(startAddr + 155);
   settings.httpAuthUser = readStringFromFlash(startAddr + 285);
   settings.httpAuthPassword = readStringFromFlash(startAddr + 415);
   Serial.println("[MEM] Settings restored from EEPROM");
   if (DEBUG_FLAG)
   {
      Serial.printf("[MEM] Settings - ClearScreen: %d BatteryWarning: %d WifiWarning: %d SleepDisabled: %d ImageMode: %d\n", settings.clearscreen, settings.showBatteryWarning, settings.showWifiWarning, settings.sleepDisabled, settings.imageMode);
   }
}

String getRedirect(String url)
{
   WiFiClientSecure secureClient;
   secureClient.setInsecure();
   HTTPClient http;
   http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
   if (url.indexOf("https:") >= 0)
   {
      http.begin(secureClient, url);
   }
   else
   {
      http.begin(url);
   }

   if (settings.httpAuthUser.length() > 0)
   {
      http.setAuthorization(settings.httpAuthUser.c_str(), settings.httpAuthPassword.c_str());
   }

   const char *headerkeys[] = {"Location"};
   size_t headerkeyssize = sizeof(headerkeys) / sizeof(char *);
   http.collectHeaders(headerkeys, headerkeyssize);
   int httpCode = http.GET();

   if (httpCode > 0)
   {
      if (httpCode == HTTP_CODE_MOVED_PERMANENTLY)
      {
         String urlNew = http.header("Location").c_str();
         Serial.println("[NETWORK] Redirect with 301");
         http.end();
         return urlNew;
      }
   }
   return url;
}

// loadImageFromWeb removed from here since it's defined later

class ServerCallbacks : public NimBLEServerCallbacks
{
   void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override
   {
      Serial.printf("\n[BLE]Client address: %s\n", connInfo.getAddress().toString().c_str());
      pServer->updateConnParams(connInfo.getConnHandle(), 24, 48, 0, 180);
      if (wifiSettings.bleInitOk)
      {
         NimBLEDevice::startAdvertising();
      }
   }
   void onDisconnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo, int reason) override
   {
      Serial.printf("\n[BLE] Client disconnected");
      if (wifiSettings.bleInitOk)
      {
         Serial.printf("\n[BLE] restart advertising...\n[");
         NimBLEDevice::startAdvertising();
      }
   };
   void onMTUChange(uint16_t MTU, NimBLEConnInfo &connInfo) override
   {
      Serial.printf("\n[BLE] MTU updated: %u for connection ID: %u\n", MTU, connInfo.getConnHandle());
   }

} serverCallbacks;

class CharacteristicCallbacks : public NimBLECharacteristicCallbacks
{
   void onRead(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override
   {
      Serial.printf("%s : onRead(), value: %s\n",
                    pCharacteristic->getUUID().toString().c_str(),
                    pCharacteristic->getValue().c_str());
   };

   void onWrite(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override
   {
      std::string uuidStr = pCharacteristic->getUUID().toString();
      size_t dataLen = pCharacteristic->getValue().length();

      // Serial.printf("%s : onWrite(), value len: %d\n", uuidStr.c_str(), dataLen);

      // Für String-Werte eine sichere Konvertierung mit dem richtigen c_str()
      if (uuidStr == "a62eed84-7b0d-11ed-a1eb-0242ac120002")
      {
         wifiSettings.pss = pCharacteristic->getValue().c_str();
         Serial.printf("[BLE] Set wifi PASS: %s\n", wifiSettings.pss.c_str());
         wifiSettings.isDeployWifi = true;
      }
      else if (uuidStr == "090b0ef2-7b0d-11ed-a1eb-0242ac120002")
      {
         wifiSettings.ssid = pCharacteristic->getValue().c_str();
         Serial.printf("[BLE] Set wifi SSID: %s\n", wifiSettings.ssid.c_str());
      }
      else if (uuidStr == "10000001-0000-0000-0000-000000000001")
      {
         settings.downloadUrl = pCharacteristic->getValue();
         Serial.printf("[BLE] Set URL: %s\n", settings.downloadUrl.c_str());
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "10000007-0000-0000-0000-000000000001")
      {
         settings.httpAuthUser = pCharacteristic->getValue();
         Serial.printf("[BLE] Set HTTP Auth user: %s\n", settings.httpAuthUser.c_str());
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "10000008-0000-0000-0000-000000000001")
      {
         settings.httpAuthPassword = pCharacteristic->getValue();
         Serial.println("[BLE] Set HTTP Auth password");
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "10000002-0000-0000-0000-000000000001")
      {
         settings.imageMode = atoi(pCharacteristic->getValue().c_str());
         Serial.printf("[BLE] Set Image Mode: %d\n", settings.imageMode);
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "10000005-0000-0000-0000-000000000001")
      {
         settings.timeout = atoi(pCharacteristic->getValue().c_str());
         Serial.printf("[BLE] Set Timeout/Sleep: %d\n", settings.timeout);
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "10000006-0000-0000-0000-000000000001")
      {
         String strVal = pCharacteristic->getValue().c_str();
         settings.clearscreen = (strVal == "1" || strVal == "true");
         Serial.printf("[BLE] Set Clearscreen: %d\n", settings.clearscreen);
         saveSettingsToFlash(EEPROM_SETTINGS_ADR);
      }
      else if (uuidStr == "10000004-0000-0000-0000-000000000001")
      {
         String cmd = pCharacteristic->getValue().c_str();
         Serial.printf("[BLE] Upload CMD: %s\n", cmd.c_str());
         if (cmd == "START")
         {
            if (SerialFlash.exists("tmp.bmp"))
            {
               SerialFlashFile f = SerialFlash.open("tmp.bmp");
               f.erase();
               f.close();
            }
            SerialFlash.createErasable("tmp.bmp", 192000);
            bleFile = SerialFlash.open("tmp.bmp");
            bleBytesReceived = 0;
            bleWriteBufferPos = 0;
            // Modus automatisch auf Lokales Bild (BLE) wechseln
            settings.imageMode = 0;
            saveSettingsToFlash(EEPROM_SETTINGS_ADR);
            Serial.println("[BLE] Upload STARTED. Switched to ImageMode 0.");
         }
         else if (cmd == "END")
         {
            if (bleFile)
            {
               if (bleWriteBufferPos > 0)
               {
                  bleFile.write(bleWriteBuffer, bleWriteBufferPos);
                  bleWriteBufferPos = 0;
               }
               bleFile.close();
            }
            Serial.printf("[BLE] Upload ENDED. Bytes: %d\n", bleBytesReceived);
            if (bleBytesReceived != 192000)
            {
               Serial.printf("[BLE] WARNING: Payload size mismatch! Expected 192000, got %d. Image will be corrupted!\n", bleBytesReceived);
            }
            // setupModeComplete erst bei APPLY auf true setzen!
         }
         else if (cmd == "APPLY")
         {
            Serial.println("[BLE] Settings APPLY received.");
            setupModeComplete = true;
         }
         else if (cmd == "RESET")
         {
            Serial.println("[BLE] Settings RESET received.");
            resetAll(true);
            ESP.restart();
         }
      }
      else if (uuidStr == "10000003-0000-0000-0000-000000000001")
      {
         const uint8_t *pData = pCharacteristic->getValue().data();
         if (bleFile && pData && dataLen > 0)
         {
            if (bleWriteBufferPos + dataLen > BLE_BUFFER_SIZE)
            {
               bleFile.write(bleWriteBuffer, bleWriteBufferPos);
               bleWriteBufferPos = 0;
            }
            if (dataLen > BLE_BUFFER_SIZE)
            {
               bleFile.write(pData, dataLen);
            }
            else
            {
               memcpy(bleWriteBuffer + bleWriteBufferPos, pData, dataLen);
               bleWriteBufferPos += dataLen;
            }
            bleBytesReceived += dataLen;
         }
      }
   };

   void onStatus(NimBLECharacteristic *pCharacteristic, int code) override
   {
      Serial.printf("Notification/Indication return code: %d, %s\n", code, NimBLEUtils::returnCodeToString(code));
   }
} chrCallbacks;

/** Handler class for descriptor actions */
class DescriptorCallbacks : public NimBLEDescriptorCallbacks
{
   void onWrite(NimBLEDescriptor *pDescriptor, NimBLEConnInfo &connInfo) override
   {
      std::string dscVal = pDescriptor->getValue();
      Serial.printf("[BLE] Descriptor written value: %s\n", dscVal.c_str());
   }

   void onRead(NimBLEDescriptor *pDescriptor, NimBLEConnInfo &connInfo) override
   {
      Serial.printf("[BLE] %s Descriptor read\n", pDescriptor->getUUID().toString().c_str());
   }
} dscCallbacks;

bool BleInit(String deviceId, bool enable)
{
   if (!enable)
   {
      if (wifiSettings.bleInitOk)
      {
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
   if (wifiSettings.bleInitOk)
   {
      Serial.println("[BLE] already initialized, skip...");
      return true;
   }
   ledBlink(200, true);
   String wifiSsidScan;
   WiFi.mode(WIFI_STA);
   delay(100);
   Serial.println("[NETWORK] scan start");
   int n = WiFi.scanNetworks();
   if (n == 0)
   {
      Serial.println("no networks found");
   }
   else
   {
      Serial.print(n);
      Serial.println(" networks found");
#if DEBUG
      for (int i = 0; i < n; ++i)
      {
         Serial.print(i);
         Serial.print(": ");
         Serial.print(WiFi.SSID(i));
         Serial.print(" -> ");
         Serial.println(WiFi.RSSI(i));
      }
#endif
      for (int i = 0; i < n; ++i)
      {
         wifiSsidScan = wifiSsidScan + WiFi.SSID(i) + "´";
         wifiSsidScan = wifiSsidScan + WiFi.RSSI(i) + "´´";

         if (wifiSsidScan.length() > 460)
         {
            wifiSsidScan = wifiSsidScan + "´...´...´";
            break;
         }
      }
   }

   NimBLEDevice::init(deviceId.c_str());
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
   NimBLECharacteristic *wifiScanCharacteristic = deviceDataService->createCharacteristic("5131a3fc-7b0e-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ);

   NimBLEService *wifiDataService = pServer->createService("0515c086-7b0c-11ed-a1eb-0242ac120002");
   NimBLECharacteristic *wifiSsidCharacteristic = wifiDataService->createCharacteristic("090b0ef2-7b0d-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *wifiPwCharacteristic = wifiDataService->createCharacteristic("a62eed84-7b0d-11ed-a1eb-0242ac120002", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);

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
   NimBLECharacteristic *uploadCmdCharacteristic = epaperSettingsService->createCharacteristic("10000004-0000-0000-0000-000000000001", NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *timeoutCharacteristic = epaperSettingsService->createCharacteristic("10000005-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *clearscreenCharacteristic = epaperSettingsService->createCharacteristic("10000006-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *httpAuthUserCharacteristic = epaperSettingsService->createCharacteristic("10000007-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);
   NimBLECharacteristic *httpAuthPasswordCharacteristic = epaperSettingsService->createCharacteristic("10000008-0000-0000-0000-000000000001", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE);

   urlCharacteristic->setCallbacks(&chrCallbacks);
   imageModeCharacteristic->setCallbacks(&chrCallbacks);
   uploadDataCharacteristic->setCallbacks(&chrCallbacks);
   uploadCmdCharacteristic->setCallbacks(&chrCallbacks);
   timeoutCharacteristic->setCallbacks(&chrCallbacks);
   clearscreenCharacteristic->setCallbacks(&chrCallbacks);
   httpAuthUserCharacteristic->setCallbacks(&chrCallbacks);
   httpAuthPasswordCharacteristic->setCallbacks(&chrCallbacks);

   wifiDataService->start();
   deviceDataService->start();
   epaperSettingsService->start();

   wifiSsidCharacteristic->setValue(wifiSettings.ssid.c_str());
   wifiPwCharacteristic->setValue(wifiSettings.pss.c_str());
   uint8_t initVal = wifiSettings.wifiIsConnected ? 1 : 0;
   wifiConnectedCharacteristic->setValue(&initVal, 1);
   wifiInfoCharacteristic->setValue("{}");
   wifiScanCharacteristic->setValue(wifiSsidScan);

   urlCharacteristic->setValue(settings.downloadUrl.c_str());
   char imgModeStr[8];
   sprintf(imgModeStr, "%d", settings.imageMode);
   imageModeCharacteristic->setValue(imgModeStr);

   char timeoutStr[16];
   sprintf(timeoutStr, "%d", settings.timeout);
   timeoutCharacteristic->setValue(timeoutStr);

   clearscreenCharacteristic->setValue(settings.clearscreen ? "1" : "0");
   httpAuthUserCharacteristic->setValue(settings.httpAuthUser.c_str());
   httpAuthPasswordCharacteristic->setValue(settings.httpAuthPassword.c_str());

   pAdvertising = NimBLEDevice::getAdvertising();
   pAdvertising->setName(deviceId.c_str());
   pAdvertising->addServiceUUID(wifiDataService->getUUID());
   pAdvertising->addServiceUUID(deviceDataService->getUUID());
   pAdvertising->addServiceUUID(epaperSettingsService->getUUID());
   pAdvertising->enableScanResponse(true);
   pAdvertising->start();

   Serial.printf("[BLE] BLE Advertising started: %s \n", deviceId.c_str());
   wifiSettings.bleInitOk = true;
   return true;
}
// https://forum.arduino.cc/index.php?topic=565603.0
int downloadAndSaveFile(String fileName, String url)
{
   bool success = 0;
   int systemFileSize = 0;
   WiFi.setSleep(false);
   WiFiClientSecure secureClient;
   secureClient.setInsecure();
   HTTPClient http;
   http.setTimeout(10000);
   http.setReuse(true);

   if (url.indexOf("https:") >= 0)
   {
      Serial.println("[DL] Download HTTPS");
      http.begin(secureClient, url);
   }
   else
   {
      Serial.println("[DL] Download HTTP");
      http.begin(url);
   }

   if (settings.httpAuthUser.length() > 0)
   {
      http.setAuthorization(settings.httpAuthUser.c_str(), settings.httpAuthPassword.c_str());
      Serial.println("[DL] HTTP Auth enabled");
   }

   const char *headerKeys[] = {"Last-Modified"};
   http.collectHeaders(headerKeys, 1);

   int httpCode = http.GET();

   if (httpCode > 0)
   {
      // file found at server
      if (httpCode == HTTP_CODE_OK)
      {
         String lastMod = http.header("Last-Modified");
         if (lastMod.length() > 0 && lastMod == settings.lastModified)
         {
            Serial.println("[DL] File not modified, skipping download.");
            http.end();
            return 1; // 1 means not modified
         }

         int len = http.getSize();
         httpFileSize = len;

         if (SerialFlash.exists(fileName.c_str()))
         {
            Serial.println("[FLASH] Delete File");
            saveFile = SerialFlash.open(fileName.c_str());
            saveFile.erase();
            saveFile.close();
         }

         SerialFlash.createErasable(fileName.c_str(), httpFileSize);
         saveFile = SerialFlash.open(fileName.c_str());

         Serial.print("[DL] Download Size: ");
         Serial.println(len);
         int buff_size = 8128;
         unsigned char *buff = (unsigned char *)malloc(buff_size);

         WiFiClient *stream = http.getStreamPtr();
         size_t downloaded_data_size = 0;
         while (http.connected() && (len > 0 || len == -1))
         {
            // Available limited to 16328 bytes. Might be TLS segementation.
            size_t size = stream->available();
            if (size)
            {
               int c = stream->read(buff, ((size > buff_size) ? buff_size : size));
               saveFile.write(buff, c);
               if (len > 0)
               {
                  len -= c;
               }
               downloaded_data_size += size;
            }
            else
            {
               delay(1);
            }
            if (WiFi.status() != WL_CONNECTED)
            {
               http.end();
               saveFile.close();
               free(buff);
               return -4;
            }
         }
         systemFileSize = saveFile.size();
         Serial.print("[FLASH] File size: ");
         Serial.println(systemFileSize);
         Serial.print("[DL] File Diff: ");
         int dif = systemFileSize - httpFileSize;
         Serial.println(dif);
         int maxDif = (httpFileSize / 80) * -1;
         if (maxDif > -2000)
         {
            maxDif = -5000;
         }
         Serial.print("[DL] MAX Diff: ");
         Serial.println(maxDif);
         free(buff);
         if (dif < maxDif)
         {
            success = -8;
         }
         else
         {
            if (lastMod.length() > 0)
            {
               settings.lastModified = lastMod;
               saveSettingsToFlash(EEPROM_SETTINGS_ADR);
            }
         }
         saveFile.close();
      }
   }
   else
   {
      Serial.println("[DL] Error on HTTP request");
      success = -2;
   }
   http.end();
   return success;
}

uint16_t getColor(uint8_t color)
{
   switch (color)
   {
   case 0:
      return GxEPD_BLACK;
      break;
   case 1:
      return GxEPD_BLUE;
      break;
   case 2:
      return GxEPD_GREEN;
      break;
   case 3:
      return GxEPD_RED;
      break;
   case 5:
      return GxEPD_YELLOW;
      break;
   case 6:
      return GxEPD_WHITE;
      break;
   default:
      return GxEPD_WHITE;
      break;
   }
}

bool waitDisplayComplete(bool quick)
{
   int counter = 0;
   while (counter < 20)
   {
      counter++;
      if (quick)
         counter = 21;
      bool pinState = digitalRead(BUSY_PIN);
      if (pinState)
      {
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

// https://github.com/zenmanenergy/ESP8266-Arduino-Examples/blob/master/helloWorld_urlencoded/urlencode.ino
unsigned char h2int(char c)
{
   if (c >= '0' && c <= '9')
   {
      return ((unsigned char)c - '0');
   }
   if (c >= 'a' && c <= 'f')
   {
      return ((unsigned char)c - 'a' + 10);
   }
   if (c >= 'A' && c <= 'F')
   {
      return ((unsigned char)c - 'A' + 10);
   }
   return (0);
}

String urldecode(String str)
{
   String encodedString = "";
   char c;
   char code0;
   char code1;
   for (int i = 0; i < str.length(); i++)
   {
      c = str.charAt(i);
      if (c == '+')
      {
         encodedString += ' ';
      }
      else if (c == '%')
      {
         i++;
         code0 = str.charAt(i);
         i++;
         code1 = str.charAt(i);
         c = (h2int(code0) << 4) | h2int(code1);
         encodedString += c;
      }
      else
      {
         encodedString += c;
      }
      yield();
   }
   return encodedString;
}

int storeSleepTimeMem(int updateTime)
{
   int returnSleepTime = readIntFromFlash(210);
   if (returnSleepTime == -1)
      returnSleepTime = DEFAULT_SLEEP;
   if (updateTime > 0)
   {
      if (returnSleepTime != updateTime)
      {
         systemData.newSleepTimeSet = true;
         if (DEBUG_FLAG)
            Serial.printf("[MEM] Update Sleep Time to %d\n", updateTime);
         writeIntToFlash(updateTime, 210);
      }
      returnSleepTime = updateTime;
   }
   else
   {
      if (DEBUG_FLAG)
         Serial.printf("[MEM] Get Sleep Time: %d\n", returnSleepTime);
   }
   return returnSleepTime;
}

void debugFS()
{
#if DEBUG
   Serial.printf("[MAIN] SPIFFS usage %d/%d heap free: %d/%d\n", SPIFFS.usedBytes(), SPIFFS.totalBytes(), ESP.getFreeHeap(), ESP.getHeapSize());
#endif
}

void displayOverlays(DisplayType &display, displayInfo displayData, bool invertColors, bool fullcolor)
{
   int16_t tw = 0;
   int foreGround = GxEPD_WHITE_I;
   int backGround = GxEPD_BLACK_I;
   if (fullcolor)
   {
      foreGround = GxEPD_WHITE;
      backGround = GxEPD_BLACK;
   }
   if (invertColors)
   {
      // invert again
      int tempStore = foreGround;
      foreGround = backGround;
      backGround = tempStore;
   }
   char charBuffer[128];
   char charBuffer2[128];
   int pos = 0;

   if (displayData.deviceInfoString)
   {
      int deviceIdPos = 20;

      u8g2_for_adafruit_gfx.setForegroundColor(backGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(foreGround); // apply Adafruit GFX color

      sprintf(charBuffer, "ID: %s", CLIENT_ID);
      String wifiSSID = WiFi.SSID();
      if (wifiSSID.length() > 1)
      {
         sprintf(charBuffer2, "%s WiFi: %s", charBuffer, wifiSSID.c_str());
         sprintf(charBuffer, "%s", charBuffer2);
      }
      else
      {
         sprintf(charBuffer2, "%s WiFi: NOT SET", charBuffer);
         sprintf(charBuffer, "%s", charBuffer2);
      }

      u8g2_for_adafruit_gfx.setFont(FONT_INFO);                                        // extended font
      tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer);                             // text box width
      u8g2_for_adafruit_gfx.setCursor((EPD_HEIGHT - tw) / 2, EPD_WIDTH - deviceIdPos); // start writing at this position
      u8g2_for_adafruit_gfx.print(charBuffer);
   }

   if (displayData.batteryLowBig)
   {
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
   if (displayData.version)
   {
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
   if (displayData.batteryInfo)
   {
      u8g2_for_adafruit_gfx.setFont(FONT_VERSION);          // extended font
      u8g2_for_adafruit_gfx.setForegroundColor(foreGround); // apply Adafruit GFX color
      u8g2_for_adafruit_gfx.setBackgroundColor(backGround); // apply Adafruit GFX color
      systemData.vddValue = readVDD(false);

      sprintf(charBuffer, "Bat: %dV", systemData.vddValue);

      tw = u8g2_for_adafruit_gfx.getUTF8Width(charBuffer); // text box width
      display.fillRect(EPD_HEIGHT - tw - 2 - pos, EPD_WIDTH - 7, tw + 3, 8, backGround);
      u8g2_for_adafruit_gfx.setCursor(EPD_HEIGHT - tw - 1 - pos, EPD_WIDTH - 1);
      u8g2_for_adafruit_gfx.print(charBuffer);
      pos = pos + 60;
   }

   if (displayData.wifiSignal)
   {
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

int loadImageFromWeb(String url, String fileName)
{
   if (url.length() < 1)
      return -2;
   Serial.print("[DL] Download Image file: ");
   Serial.println(url);
   // int setImage = 0; // Trigger refresh
   int downloadOk = 0;
   String newUrl = getRedirect(url);
   for (int i = 0; i <= 5; i++)
   {
      debugFS();
      downloadOk = downloadAndSaveFile(fileName, newUrl);
      if (downloadOk == 0 || downloadOk == 1)
      {
         return 0;
      }
      else
      {
         if (WiFi.status() != WL_CONNECTED)
         {
            WiFi.disconnect(true);
            WiFi.begin(wifiSettings.ssid.c_str(), wifiSettings.pss.c_str());
            delay(3000);
         }
      }
   }
   return -1;
}

int setImageFromFS(String fileName)
{
   epaperIsUpdating = true;
   saveFile = SerialFlash.open(fileName.c_str());
   if (!saveFile)
   {
      Serial.println("[BMP] File missing");
      return -1;
   }

   uint16_t width = EPD_WIDTH;
   uint16_t height = EPD_HEIGHT;
   int offsetData = 0;

   // Check if the file is a standard BMP (starts with 'BM')
   uint8_t magic[2];
   if (saveFile.read(magic, 2) == 2)
   {
      if (magic[0] == 'B' && magic[1] == 'M')
      {
         // It's a standard BMP file. Read the pixel data offset at byte 0x0A
         saveFile.seek(0x0A);
         uint32_t bmpOffset = 0;
         saveFile.read((uint8_t *)&bmpOffset, 4);
         offsetData = bmpOffset;
         Serial.printf("[BMP] Detected Windows BMP. Pixel Data starts at offset: %d\n", offsetData);
      }
      else
      {
         Serial.println("[BMP] Detected RAW payload (no BM magic). Reading from byte 0.");
      }
   }

   Serial.printf("[BMP] Loading Image H: %d W: %d\n", height, width);

   if (width > EPD_WIDTH || height > EPD_HEIGHT)
   {
      Serial.printf("[BMP] Image too wide or tall!");
      return -1;
   }

   display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
   display.init(115200);
   display.setRotation(displaySettings.rotationPicture);
   display.setFullWindow();
   Serial.print("[EPD] Update Display... \n");

   int bufferSize = width / 2;
   uint8_t *lineBuffer = (uint8_t *)malloc(bufferSize);

   display.firstPage();
   do
   {
      display.fillScreen(GxEPD_WHITE);
      saveFile.seek(offsetData);

      for (int y = 0; y < height; y++)
      {
         saveFile.read(lineBuffer, bufferSize);
         for (int x = 0; x < width; x++)
         {
            uint8_t colorData = lineBuffer[x / 2];
            uint8_t colorNibble = (x % 2 == 0) ? (colorData >> 4) : (colorData & 0x0F);
            if (colorNibble != 6)
            { // Optimization: display is already filled with WHITE (6)
               display.drawPixel(x, y, getColor(colorNibble));
            }
         }
      }

   } while (display.nextPage());

   free(lineBuffer);
   Serial.println("[EPD] End Draw...");
   epaperIsUpdating = false;
   return 0;
}

void displaySetText(String info, bool isBlackboard, bool quickRefresh)
{
   int foreGround = GxEPD_BLACK_I;
   int backGround = GxEPD_WHITE_I;
   int fill = GxEPD_WHITE_I;
   bool invert = false;
   bool fullcolor = false;
   if (isBlackboard)
   {
      invert = true;
      foreGround = GxEPD_WHITE_I;
      backGround = GxEPD_BLACK_I;
      fill = GxEPD_BLACK_I;
   }
   if (!displaySettings.quickRefresh)
   {
      quickRefresh = false;
   }
   if (quickRefresh)
   {
      fullcolor = false;
      display.init(115200);
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, true);
   }
   else
   {
      if (isBlackboard)
      {
         foreGround = GxEPD_WHITE;
         backGround = GxEPD_BLACK;
         fill = GxEPD_BLACK;
      }
      else
      {
         foreGround = GxEPD_BLACK;
         backGround = GxEPD_WHITE;
         fill = GxEPD_WHITE;
      }
      fullcolor = true;
      display.enableQuickRefresh(displaySettings.displayQuickRefreshTime, false);
      display.init(115200);
   }

   display.setRotation(displaySettings.rotationText);
   display.firstPage();
   do
   {
      display.fillRect(0, 0, EPD_HEIGHT, EPD_WIDTH, fill);
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
      if (info.length() > 1)
      {
         displayInfos.deviceInfoString = true;
      }

      displayOverlays(display, displayInfos, invert, fullcolor);

   } while (display.nextPage());
}

void displayWipe(bool quick)
{
   int fill = GxEPD_WHITE;

   if (quick)
   {
      display.init(115200);
      display.enableQuickRefresh(5200, true);
      fill = GxEPD_WHITE_I;
   }
   else
   {
      display.init(115200);
      display.enableQuickRefresh(5200, false);
      fill = GxEPD_WHITE;
   }
   display.setRotation(1);
   display.firstPage();
   do
   {
      display.fillRect(0, 0, EPD_HEIGHT, EPD_WIDTH, fill);
   } while (display.nextPage());
}

String setLeadingZero(String input)
{
   String result = "";
   if (input.length() == 1)
   {
      result = "0" + input;
   }
   else
   {
      result = input;
   }

   return result;
}

void setDeviceUid()
{
   byte mac[6];
   WiFi.mode(WIFI_STA);
   WiFi.macAddress(mac);
   if (DEBUG_FLAG)
   {
      Serial.print("[WIFI] MAC: ");
      for (int i = 0; i < 6; i++)
      {
         Serial.printf("%02X", mac[i]);
         if (i < 5)
         {
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
void gotToDeepSleep(int wakeuptimeout, bool showScreen, bool motionWake)
{
   Serial.printf("[MAIN] Going to Sleep for %d seconds (MotionWake: %d)\n", wakeuptimeout, motionWake);
   checkOrientationInBackground(0, false);
   if (!settings.sleepDisabled)
      WiFi.disconnect(true);
   if (motionWake)
   {
      accIntSet(80); // Set acc int wakeup /TODO: disable if no motion wakeup
   }
   else
   {
      accIntSet(0);
   }
   waitDisplayComplete(false);
   if (wakeuptimeout <= 0 && showScreen)
   {
      waitDisplayComplete(true);
   }
   ledBlink(0, false);
   delay(5);
   display.hibernate();
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
   pinMode(CHG_EN_PIN, INPUT);
   pinMode(12, INPUT); // USB TEST PINS
   pinMode(13, INPUT); // USB TEST PINS
   if (settings.sleepDisabled)
   {
      Serial.printf("[SLEEP] enter soft sleep\n");
      tickerFailsave.detach();
      ledBlink(2000, true);
      while (true)
      {
         // TODO: add trigger for reboot via wifi or ble for soft sleep
         delay(100);
      }
   }
   esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
   if (wakeuptimeout > 0)
   {
      esp_sleep_enable_timer_wakeup(wakeuptimeout * uS_TO_S_FACTOR);
   }
   else
   {
      esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
   }
   if (motionWake)
   {
      esp_sleep_enable_ext1_wakeup_io(BUTTON_PIN_BITMASK(GPIO_NUM_0), ESP_EXT1_WAKEUP_ANY_HIGH);
      rtc_gpio_pulldown_en(GPIO_NUM_0);
      rtc_gpio_pullup_dis(GPIO_NUM_0);
   }
   esp_deep_sleep_start();
   ESP.restart(); // will never reach in deep sleep
}

int calculateSleepDuration(int defaultTimeout, bool forceReset, bool getDataOnly)
{
   struct timeval now;
   gettimeofday(&now, NULL);

   if (getDataOnly)
   {
      time_t diff = now.tv_sec - previousWakeup.tv_sec;
      int predictedSleep = defaultTimeout - diff;
      if (predictedSleep < SLEEP_RECALCULATION_PERIOD_SECONDS || predictedSleep <= 0)
      {
         predictedSleep = defaultTimeout;
      }
      Serial.printf("[SLEEP] Return predicted sleep data only: %d \n", predictedSleep);

      return predictedSleep;
   }

   if (systemData.wakeupCause == wakeup_reason_t::TIMER)
   {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] no manual wakeup (timer) - using full wakeup period...\n");
      previousWakeup = now;
      return defaultTimeout;
   }
   if (systemData.wakeupCause == wakeup_reason_t::BUTTON)
   {
      // TODO: cloud time feedback is needed here to calculate new wakeup
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] button wakeup - not able to calculate new sleep internally...\n");
      previousWakeup = now;
      return defaultTimeout;
   }
   if (forceReset)
   {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] force reset - using full wakeup period...\n");
      previousWakeup = now;
      return defaultTimeout;
   }

   if (previousWakeup.tv_sec > now.tv_sec)
   {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] detected invalid previous wakeup, resetting...\n");
      previousWakeup = timeval{
          .tv_sec = 0,
          .tv_usec = 0};
   }

   time_t diff = now.tv_sec - previousWakeup.tv_sec;

   if (diff <= 0)
   {
      if (DEBUG_FLAG)
         Serial.printf("[SLEEP] detected non positive sleep difference, resetting...\n");
      previousWakeup = now;
      diff = 0;
   }

   Serial.printf("[SLEEP] current time: %lld, previous time: %lld, difference: %lld\n", now.tv_sec, previousWakeup.tv_sec, diff);
   int predictedSleep = defaultTimeout - diff;
   // if the user refreshes less than one minute before the actual refresh will occur, skip that next refresh and use the current one instead.
   if (predictedSleep < SLEEP_RECALCULATION_PERIOD_SECONDS || predictedSleep <= 0)
   {
      Serial.printf("[SLEEP] manual reset within %d seconds of wakeup window. Reset to full window next\n", SLEEP_RECALCULATION_PERIOD_SECONDS);
      previousWakeup = now;
      return defaultTimeout;
   }

   return predictedSleep;
}

wakeup_reason_t getWakeupReason()
{
   int resetReason0 = rtc_get_reset_reason(0);
   int resetReason1 = rtc_get_reset_reason(1);
   int wakeupReason = esp_sleep_get_wakeup_cause();
#if DEBUG
   Serial.printf("[WAKE] Reset Reason 0: %d\n", resetReason0);
   Serial.printf("[WAKE] Reset Reason 1: %d\n", resetReason1);
   Serial.printf("[WAKE] Wake Reason: %d\n", wakeupReason);
#endif
   if (wakeupReason == esp_sleep_wakeup_cause_t::ESP_SLEEP_WAKEUP_UNDEFINED && resetReason0 == 1 && resetReason1 == 1)
   {
      Serial.printf("[WAKE] Got Button Wakeup or Power Loss Wakeup\n");
      return wakeup_reason_t::BUTTON;
   }
   if (wakeupReason == esp_sleep_wakeup_cause_t::ESP_SLEEP_WAKEUP_EXT1)
   {
      Serial.printf("[WAKE] Got Motion Wakeup\n");
      return wakeup_reason_t::MOTION;
   }
   if (wakeupReason == esp_sleep_wakeup_cause_t::ESP_SLEEP_WAKEUP_TIMER)
   {
      Serial.printf("[WAKE] Got Timer Wakeup \n");
      return wakeup_reason_t::TIMER;
   }
   Serial.printf("[WAKE] Got Button System Reset or Others\n");
   return wakeup_reason_t::SYSTEM_RESET;
}

bool usbInit()
{
   Wire.beginTransmission(USBC_ADDR);
   Wire.write(0x01);
   Wire.endTransmission(true); // end write operation, as we just wanted to select the starting register

   Wire.requestFrom(USBC_ADDR, 1); // request 6 bytes from peripheral device #8
   char c = Wire.read();           // receive a byte as character
   if (c == 0b00010000)
   {
      Serial.println("[USB] init OK");
      return true;
   }
   else
   {
      Serial.println("[USB] init FAIL");
      return false;
   }
}

bool usbCheckConnect()
{
   Wire.beginTransmission(USBC_ADDR);
   Wire.write(0x11);
   Wire.endTransmission(true); // end write operation, as we just wanted to select the starting register

   Wire.requestFrom(USBC_ADDR, 1); // request 6 bytes from peripheral device #8
   char c = Wire.read();           // receive a byte as character
   char usbPower = (c >> 3) & 0x01;
   char usbPowerLow = (c >> 6) & 0x01;
   if (usbPower && !usbPowerLow)
   {
      return true;
   }
   else
   {
      return false;
   }
}

int accInit(bool skipInit)
{
   int orientation = 0;
   if (!skipInit)
   {
      if (myIMU.begin(6.25, 2, false) == IMU_SUCCESS)
      {
         if (DEBUG_FLAG)
            Serial.println("[ACC] initialized.");
      }
      else
      {
         Serial.println("[ACC] Failed to initialize.");
         return -1;
         // while (true);  // stop running sketch if failed
      }

      uint8_t readData = 0;

// Get the ID:
#if DEBUG
      if (myIMU.readRegister(&readData, KXTJ3_WHO_AM_I) ==
          IMU_SUCCESS)
      {
      }
      else
      {
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

   if (myIMU.readRegister(&dataLowRes, KXTJ3_XOUT_H) ==
       IMU_SUCCESS)
   {
      // Read accelerometer data in mg as Float
      float acc_x_loc = myIMU.axisAccel(X);
      acc_x = round((int)(acc_x_loc * 10));
   }

   if (myIMU.readRegister(&dataLowRes, KXTJ3_YOUT_H) ==
       IMU_SUCCESS)
   {
      // Read accelerometer data in mg as Float
      float acc_y_loc = myIMU.axisAccel(Y);
      acc_y = round((int)(acc_y_loc * 10));
   }

   if (myIMU.readRegister(&dataLowRes, KXTJ3_ZOUT_H) ==
       IMU_SUCCESS)
   {
      // Read accelerometer data in mg as Float
      float acc_z_loc = myIMU.axisAccel(Z);
      acc_z = round((int)(acc_z_loc * 10));
   }

   if (acc_x > 5 && acc_y < 5 && acc_y > -5)
   {
      orientation = 0;
   }
   if (acc_x < 5 && acc_x > -5 && acc_y > 5)
   {
      orientation = 1;
   }
   if (acc_x < -5 && acc_y < 5 && acc_y > -5)
   {
      orientation = 2;
   }
   if (acc_x < 5 && acc_x > -5 && acc_y < -5)
   {
      orientation = 3;
   }

   if (DEBUG_FLAG && !skipInit)
      Serial.printf("[ACC] Values: X:%d Y:%d Z:%d Orient: %d \n", acc_x, acc_y, acc_z, orientation);

   // Put IMU back into standby
   myIMU.resetInterrupt();
   myIMU.standby(true);
   return orientation;
}

bool accIntSet(int sensity)
{
   pinMode(INT_PIN, INPUT);
   if (sensity == 0)
   {
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

void recheckAccOrient(int setOrientValue)
{
   if (stopAccRecheck)
      return;
   int accCheck = accInit(true);
   if (accCheck != readIntFromFlash(220))
   {
      systemData.deviceOrientation = accCheck;
      Serial.printf("[ACC] Update Orient to Mem: %d \n", systemData.deviceOrientation);
      writeIntToFlash(systemData.deviceOrientation, 220);
      if (systemData.deviceOrientation == 2 || systemData.deviceOrientation == 3)
      {
         displaySettings.rotationText = 1;
         displaySettings.rotationPicture = 0;
      }
      if (epaperIsUpdating)
      {
         digitalWrite(RST_PIN, 1);
         delay(50); // needs a little longer
         digitalWrite(RST_PIN, 0);
         delay(20);

         ESP.restart();
      }
   }
   else
   {
      // if (DEBUG_FLAG) Serial.printf("[ACC] No Acc Update after recheck\n");
   }
}

void checkOrientationInBackground(int setOrientValue, bool isRunning)
{
   if (isRunning)
   {
      stopAccRecheck = false;
      Serial.printf("[ACC] Background update start\n");
      periodicAccCheck.attach_ms(1000, recheckAccOrient, setOrientValue);
   }
   else
   {
      Serial.printf("[ACC] Background update stop\n");
      stopAccRecheck = true;
      periodicAccCheck.detach();
      return;
   }

   return;
}

bool chargeMode(bool enable)
{
   // charge pin high disables the charger (GND enabled)
   bool chargeState = false;
   bool isCharging = false;
   pinMode(CHG_STAT_PIN, INPUT);
   delay(1);
   if (enable)
   {
      pinMode(CHG_EN_PIN, INPUT);
      delay(2);
      chargeState = digitalRead(CHG_STAT_PIN);
      if (chargeState == LOW)
      {
         Serial.println("[CHARGE] on - Charging");
         isCharging = true;
      }
      else
      {
         Serial.println("[CHARGE] on - Charge Done");
         digitalWrite(CHG_EN_PIN, LOW);
      }
   }
   else
   {
      pinMode(CHG_EN_PIN, OUTPUT);
      digitalWrite(CHG_EN_PIN, HIGH);
      delay(2);
      chargeState = digitalRead(CHG_STAT_PIN);
      if (chargeState == LOW)
      {
         Serial.println("[CHARGE] off - Charging");
         isCharging = true;
      }
      else
      {
         Serial.println("[CHARGE] off - Charge Done");
         digitalWrite(CHG_EN_PIN, LOW);
      }
   }
   return isCharging;
}

void test()
{
   // adcAttachPin(14);  // Any pin that is ADC capable
   ledBlink(0, false);
   char charBuffer[128];
   pinMode(INT_PIN, OUTPUT);
   digitalWrite(INT_PIN, LOW);
   Serial.println("[DEBUG] Test Function");
   //  displaySettings.displayQuickRefreshTime = 2900;//works cold
   ledBlink(200, false);
   delay(100);
   setImageFromFS("tmp.bmp");
   gotToDeepSleep(0, true, false);

   int timeout;
   timeout = calculateSleepDuration(DEFAULT_SLEEP, false, false);
   Serial.printf("time to next update: %d\n", timeout);
   while (true)
   {
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

bool resetAll(bool resetWifi)
{
   checkOrientationInBackground(0, false);
   Serial.printf("[MAIN] Reset - WIFI %d \n", resetWifi);

   writeIntToFlash(0, 220);          // restore screen orient to default
   storeSleepTimeMem(DEFAULT_SLEEP); // restore sleep mem store to default
   if (SerialFlash.exists("tmp.bmp"))
   {
      SerialFlashFile f = SerialFlash.open("tmp.bmp");
      f.erase();
      f.close();
   }
   settings.downloadUrl = "";
   settings.imageMode = 1;
   settings.clearscreen = true;
   settings.timeout = DEFAULT_SLEEP;
   settings.httpAuthUser = "";
   settings.httpAuthPassword = "";
   if (resetWifi)
   {
      writeStringToFlash("", 0);  // storing ssid at address 0
      writeStringToFlash("", 40); // storing pss at address 40
      wifiSettings.ssid = "";
      wifiSettings.pss = "";
      wifiSettings.wifiRetries = 0;
   }
   saveSettingsToFlash(EEPROM_SETTINGS_ADR);
   return true;
}

void startupCounter(int reset)
{
   preferences.begin("my-app", false);
   unsigned int counter = preferences.getUInt("counter", 0);
   counter++;
   if (reset || counter > 16)
   {
      if (StartCounter >= 5)
      {
         Serial.println("[MAIN] +5 button presses");
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

void setup()
{
   chargeMode(false); // enable charge mode
   pinMode(BAT_VOLT_EN_PIN, OUTPUT);
   digitalWrite(BAT_VOLT_EN_PIN, LOW);
   Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
   pinMode(LED_PIN, OUTPUT);
   digitalWrite(LED_PIN, LOW);
   Serial.begin(115200);
   analogReadResolution(12);
   systemData.usbConnected = usbCheckConnect();
   delay(80);

   systemData.vddValue = readVDD(false);
   if (!systemData.usbConnected && systemData.vddValue < 4000)
   {
      if (DEBUG_FLAG)
         Serial.printf("[MAIN] Bat low protection: %dmV\n", systemData.vddValue);
      digitalWrite(LED_PIN, HIGH);
      gotToDeepSleep(86000, false, false);
   }
   systemData.wakeupCause = getWakeupReason();

   if (systemData.wakeupCause == wakeup_reason_t::BUTTON)
   {
      buttonWake = true;
      startupCounter(false);
   }

   EepromInit(EEPROM_SIZE);

   // Load credentials & settings from EEPROM
   wifiSettings.ssid = readStringFromFlash(0);
   wifiSettings.pss = readStringFromFlash(40);
   settings.timeout = storeSleepTimeMem(0);
   restoreSettingsToFlash(EEPROM_SETTINGS_ADR);

   pinMode(12, INPUT); // USB TEST PINS
   pinMode(13, INPUT); // USB TEST PINS
   pinMode(INT_PIN, INPUT);
   pinMode(RST_PIN, OUTPUT);
   pinMode(CS_EPD_PIN, OUTPUT);
   pinMode(DC_PIN, OUTPUT);

   displayInfos.deviceInfoString = true;
   myEsp32FOTA.setManifestURL(OTA_URL);
   char firmwareVersion[] = SOFTWARE_VERSION;

   ledBlink(500, true);
   Serial.begin(115200);
   sleep(1);

   Serial.printf("[MAIN] INIT Device V: %s\n", firmwareVersion);
   if (DEBUG_FLAG)
      Serial.printf("[MAIN] Current counter value: %u VDD: %d\n", StartCounter, systemData.vddValue);
   if (!SPIFFS.begin(true))
   {
      Serial.println("[MEM] SPIFFS initialisation failed!");
   }
   WiFi.onEvent(WiFiEvent);
   SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN); // SCK(), MISO(),MOSI(), SS()
   SPI.setFrequency(20000000);
   SerialFlash.begin(CS_FLASH_PIN); // proceed even if begin() fails
   u8g2_for_adafruit_gfx.begin(display);
   chargeMode(false);

   setDeviceUid();
   // TODO: maybe do a function to generally check updated mem values

   systemData.deviceOrientation = accInit();
   // default is rotationText = 3 and rotationPicture = 2
   if (systemData.deviceOrientation == 2 || systemData.deviceOrientation == 3)
   {
      displaySettings.rotationText = 1;
      displaySettings.rotationPicture = 0;
   }
   float temperature = temperatureRead();
   if (DEBUG_FLAG)
      Serial.printf("[MAIN] Temp Main: %.2f °C\n", temperature);
   if (temperature < 21.0)
   {
      Serial.printf("[MAIN] Low Temp detected: %.2f °C - disable quick refresh\n", temperature);
      displaySettings.quickRefresh = false;
   }

#if DEBUG
   // test();              //-----------------test---------please remove
#endif

   if (buttonWake)
   {
      Serial.println("[MAIN] Setup Mode Triggered");
      displaySetText("Connect via Bluetooth", false, true);
      BleInit(CLIENT_ID, true);

      unsigned long setupModeStart = millis();
      bool bleWasConnected = false;
      bool initialWifiCheckDone = false;

      // Wait for completion, disconnect, or timeout
      while (!setupModeComplete)
      {
         if (pServer->getConnectedCount() > 0)
         {
            bleWasConnected = true;
            if (!initialWifiCheckDone && wifiSettings.ssid.length() > 0)
            {
               initialWifiCheckDone = true;
               wifiSettings.isDeployWifi = true;
            }
         }

         if (wifiSettings.isDeployWifi)
         {
            wifiSettings.wifiIsConnected = false;
            wifiSettings.wifiOnboardingFailed = false;
            wifiSettings.isDeployWifi = false;

            if (wifiSettings.bleInitOk && wifiConnectedCharacteristic)
            {
               uint8_t val = 0;
               wifiConnectedCharacteristic->setValue(&val, 1);
               wifiConnectedCharacteristic->notify();

               if (wifiInfoCharacteristic)
               {
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
            while (WiFi.status() != WL_CONNECTED && millis() - startWait < 10000)
            {
               delay(100);
            }

            if (WiFi.status() == WL_CONNECTED)
            {
               Serial.println("[WIFI] Connected successfully!");
               // check valid wifi connection
               writeStringToFlash(wifiSettings.ssid.c_str(), 0);
               writeStringToFlash(wifiSettings.pss.c_str(), 40);
            }
            else
            {
               Serial.println("[WIFI] Connection timeout!");
            }
         }

         // Timeout if no client connects within 60 seconds
         if (!bleWasConnected && (millis() - setupModeStart > SETUP_MODE_TIMEOUT * 1000))
         {
            Serial.println("[MAIN] No BLE connection within 60s. Switching to fetch/refresh mode.");
            break;
         }

         // Exit immediately if client disconnects
         if (bleWasConnected && pServer->getConnectedCount() == 0)
         {
            Serial.println("[MAIN] BLE Client disconnected. Switching to fetch/refresh mode.");
            break;
         }

         if (millis() - setupModeStart > 15 * 60 * 1000)
         {
            Serial.println("[MAIN] 15 minutes safety timeout.");
            break;
         }

         delay(100);
      }

      Serial.println("[MAIN] Setup Mode Completed or Timeout");
      BleInit(CLIENT_ID, false); // Stop BLE advertising to save memory

      // Always proceed to loop to fetch URL or refresh picture
      downloadStart = true;
      systemData.sleepPrediction = calculateSleepDuration(settings.timeout, systemData.newSleepTimeSet, false);
      delay(200);
      return;
   }

   ledBlink(500, true);
   tickerFailsave.once_ms(FAILSAVE_TIMER * 1000, timeoutFailsave, 0);

   saveSettingsToFlash(EEPROM_SETTINGS_ADR);
   storeSleepTimeMem(settings.timeout);

   systemData.sleepPrediction = calculateSleepDuration(settings.timeout, systemData.newSleepTimeSet, false);
   checkOrientationInBackground(systemData.deviceOrientation, true);

   if (SPIFFS.usedBytes() > 10000)
   {
      Serial.println("[MEM] SPIFFS seems to full ...");
   }

   esp_bt_controller_mem_release(ESP_BT_MODE_BTDM);
   delay(10);
}

void loop()
{
   if (setupModeComplete)
   {
      downloadStart = true;
      setupModeComplete = false;
   }

   if (downloadStart)
   {
      downloadStart = false;
      delay(200);
      String fileName = "tmp.bmp";
      int dlSuccess = 0;

      if (settings.imageMode == 1)
      { // URL Mode
         if (WiFi.status() != WL_CONNECTED)
         {
            WiFi.begin(wifiSettings.ssid.c_str(), wifiSettings.pss.c_str());
            int WLcount = 0;
            while (WiFi.status() != WL_CONNECTED && WLcount < 200)
            {
               delay(100);
               ++WLcount;
            }
         }

         if (WiFi.status() == WL_CONNECTED)
         {
            dlSuccess = loadImageFromWeb(settings.downloadUrl, fileName);
            Serial.println("[DL] Done");
            WiFi.setSleep(true);
         }
         else
         {
            Serial.println("[DL] WiFi Connection Failed");
            dlSuccess = -1;
         }
      }
      else
      { // BLE Mode (Mode 0)
         // In BLE mode, the image was directly uploaded to tmp.bmp
         dlSuccess = 0;
         Serial.println("[IMAGE] Using BLE uncompressed tmp.bmp");
      }

      waitDisplayComplete(false);
      delay(25);

      int setSuccess = 0;
      if (dlSuccess == 0 || dlSuccess == 1)
      { // 0 = downloaded/ok, 1 = not modified
         if (dlSuccess == 0 || settings.imageMode == 0)
         {
            setSuccess = setImageFromFS(fileName);
         }
         else
         {
            Serial.println("[IMAGE] Not rendering, image not modified");
            setSuccess = 0;
         }
      }
      else
      {
         displaySetText("Error: Picture download failed, please try again", false);
         setSuccess = -1;
      }

      debugFS();
      Serial.println("[MAIN] End of Update");
      if (settings.imageMode == 0)
      {
         gotToDeepSleep(0, false, false);
      }
      if (settings.timeout > 0)
      {
         gotToDeepSleep(systemData.sleepPrediction, false, false);
      }
      else
      {
         gotToDeepSleep(DEFAULT_SLEEP, false, false);
      }
   }

   // Keep alive for setup mode / BLE configs
   delay(500);
}