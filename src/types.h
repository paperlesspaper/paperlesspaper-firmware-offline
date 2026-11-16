#pragma once
#include <Arduino.h>

// ==========================================
// DISPLAY SELECTION (configured via platformio.ini)
// ==========================================
#if !defined(EPD_TYPE_13INCH) && !defined(EPD_TYPE_7INCH)
#define EPD_TYPE_7INCH
#endif
// ==========================================

#ifndef SOFTWARE_VERSION
#define SOFTWARE_VERSION "0.1.0"
#endif
#define MAX_OTA_FW_SIZE 0x1D0000UL
#define DEBUG 1

#define DISPLAY_SPI_SPEED 20000000
#define FLASH_SPI_SPEED 8000000
#define QR_VERSION 3
#define QR_QUIET_ZONE 4

// Gallery: limits and status codes shared with the web UI (see README, "Gallery")
#define GALLERY_MAX_ITEMS 400
#define GALLERY_HEADER_SIZE 16
#define GALLERY_MAX_THUMB_SIZE 8192
#define GALLERY_SIZE_MARGIN 1024 // a picture file may exceed header + preview + raw picture by this
#define GALLERY_READ_CHUNK 500   // most bytes of one read of a stream
#define STATUS_NO_SPACE 0xFFFC
#define STATUS_DISPLAY_BUSY 0xFFFD
#define STATUS_SEQ_ERROR 0xFFFE
#define STATUS_UPLOAD_ERROR 0xFFFF

// What the display shows (stored, so that a notice is not drawn again and again)
#define DISPLAY_PICTURE 0    // a picture, or unknown
#define DISPLAY_SETUP_HINT 1 // "not set up yet"
#define DISPLAY_ERROR_TEXT 2 // "picture download failed"
#define DISPLAY_BATTERY_EMPTY 3

typedef enum
{
   SYSTEM_RESET = 0,
   BUTTON = 1,
   MOTION = 2,
   TIMER = 3,
} wakeup_reason_t;

enum DisplayInfoKey
{
   VERSION,
   BATTERY_INFO,
   BATTERY_LOW_BIG,
   WIFI_SIGNAL,
   DEVICE_INFO_STRING,
   WIFI_OFFLINE_BIG
};

struct WifiSettings
{
   String bleSSID;
   String blePASS;
   String ssid;
   String pss;
   int wifiQuality;
   uint8_t wifiRetries;
   bool wifiIsConnected;
   bool wifiOnboardingFailed;
   bool wifiConfig;
   bool bleInitOk;
   bool isDeployWifi;
   String clientId;
};

struct DisplayInfo
{
   bool version;
   bool batteryInfo;
   bool batteryLowBig;
   bool wifiSignal;
   bool deviceInfoString;
   bool wifiOfflineBig;
};

struct DisplaySettings
{
   uint8_t rotationText;
   uint8_t rotationPicture;
   bool quickRefresh;
   bool globalQuickRefreshDisable;
   int displayQuickRefreshTime;
   int displayQuickRefreshWipeTime;
   uint16_t colorWhiteFast;
   uint16_t colorBlackFast;
   uint8_t colorWipeFast;
   uint8_t displayType;
};

struct Settings
{
   int timeout;
   String lut;
   bool clearscreen;
   bool showBatteryWarning;
   bool showWifiWarning;
   bool sleepDisabled;
   String downloadUrl;
   String httpAuthUser;
   String httpAuthPassword;
   String lastModified;
   int imageMode;
   bool motionWakeup;
   bool chargerMode;
   String settingsUrl;
   String settingsLastModified;
   bool autoRotation;
   bool forceDownload;
   bool skipSetupMode;
};

struct SystemData
{
   wakeup_reason_t wakeupCause;
   int vddValue;
   u_int8_t ledDimValue;
   int sleepPrediction;
   bool newSleepTimeSet;
   bool usbConnected;
   int deviceOrientation;
   bool displayPowerOn;
   bool sdIsInit;
   bool sdReady;
   bool charging; // last state reported by chargeMode()
};

struct DataLayout
{
   int integer;
   char byte[4];
};
