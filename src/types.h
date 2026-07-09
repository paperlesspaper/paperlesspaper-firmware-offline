#pragma once
#include <Arduino.h>

// ==========================================
// DISPLAY SELECTION
// ==========================================
#define EPD_TYPE_13INCH
// #define EPD_TYPE_7INCH
// ==========================================

#define SOFTWARE_VERSION "0.0.0"
#define DEBUG 1

#define DISPLAY_SPI_SPEED 20000000
#define QR_VERSION 3
#define QR_QUIET_ZONE 4

typedef enum {
   SYSTEM_RESET = 0,
   BUTTON = 1,
   MOTION = 2,
   TIMER = 3,
} wakeup_reason_t;

enum DisplayInfoKey {
   VERSION,
   BATTERY_INFO,
   BATTERY_LOW_BIG,
   WIFI_SIGNAL,
   DEVICE_INFO_STRING,
   WIFI_OFFLINE_BIG
};

struct WifiSettings {
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

struct DisplayInfo {
   bool version;
   bool batteryInfo;
   bool batteryLowBig;
   bool wifiSignal;
   bool deviceInfoString;
   bool wifiOfflineBig;
};

struct DisplaySettings {
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

struct Settings {
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
};

struct SystemData {
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
};

struct DataLayout {
   int integer;
   char byte[4];
};
