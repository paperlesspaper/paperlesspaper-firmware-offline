#include "usb_link.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <rom/crc.h>

// main.cpp
void gattRead(NimBLECharacteristic *pCharacteristic, uint16_t mtu);
void gattWrite(NimBLECharacteristic *pCharacteristic);
void serialBootloaderByte(int received);
void abortTransfers();
extern char CLIENT_ID[20];
extern volatile bool isBleClientConnected;

namespace {

const uint8_t START_0 = 0xA5;
const uint8_t START_1 = 0x5A;
const uint8_t TYPE_HELLO = 0x01;
const uint8_t TYPE_PING = 0x02;
const uint8_t TYPE_BYE = 0x03;
const uint8_t TYPE_READ = 0x10;
const uint8_t TYPE_WRITE = 0x11;
const uint8_t TYPE_WRITE_NR = 0x12;
const uint8_t TYPE_NOTIFY = 0x20;
const uint8_t TYPE_ERROR = 0x7F;
const uint8_t TYPE_ANSWER = 0x80; // added to the type of the request

const uint16_t LINK_MTU = 517; // makes gattRead() use the largest packets
const int HEADER_SIZE = 8;     // type, seq, len, key
const int MAX_CHARACTERISTICS = 32;

struct Entry
{
   uint32_t key; // first 32 bits of the UUID
   NimBLECharacteristic *characteristic;
};
Entry entries[MAX_CHARACTERISTICS];
int entryCount = 0;

TaskHandle_t task = nullptr;     // serves a session
TaskHandle_t listener = nullptr; // waits for the start of one
SemaphoreHandle_t sendLock = nullptr;
volatile bool sessionActive = false;
volatile bool stopRequested = false;
unsigned long lastFrameAt = 0;

// frame being received
enum ParseState : uint8_t
{
   WAIT_START_0,
   WAIT_START_1,
   READ_HEADER,
   READ_PAYLOAD,
   READ_CRC
};
ParseState parseState = WAIT_START_0;
uint8_t frame[HEADER_SIZE + USB_LINK_MAX_PAYLOAD + 4];
uint16_t framePos = 0;
uint16_t payloadLen = 0;

void sendFrame(uint8_t type, uint8_t seq, uint32_t key, const uint8_t *payload, uint16_t len) {
   static uint8_t out[2 + HEADER_SIZE + USB_LINK_MAX_PAYLOAD + 4];
   if (len > USB_LINK_MAX_PAYLOAD || sendLock == nullptr)
      return;
   xSemaphoreTake(sendLock, portMAX_DELAY);
   out[0] = START_0;
   out[1] = START_1;
   out[2] = type;
   out[3] = seq;
   out[4] = len & 0xFF;
   out[5] = len >> 8;
   out[6] = key & 0xFF;
   out[7] = (key >> 8) & 0xFF;
   out[8] = (key >> 16) & 0xFF;
   out[9] = (key >> 24) & 0xFF;
   if (len > 0)
      memcpy(out + 10, payload, len);
   const uint32_t crc = crc32_le(0, out + 2, HEADER_SIZE + len);
   out[10 + len] = crc & 0xFF;
   out[11 + len] = (crc >> 8) & 0xFF;
   out[12 + len] = (crc >> 16) & 0xFF;
   out[13 + len] = (crc >> 24) & 0xFF;
   Serial.write(out, (size_t)14 + len); // one call: log lines of other tasks cannot split the frame
   xSemaphoreGive(sendLock);
}

NimBLECharacteristic *find(uint32_t key) {
   for (int i = 0; i < entryCount; i++) {
      if (entries[i].key == key)
         return entries[i].characteristic;
   }
   return nullptr;
}

void endSession() {
   if (!sessionActive)
      return;
   sessionActive = false;
   Serial.flush();
   Serial.updateBaudRate(115200);
   Serial.println("\n[USB] Session ended");
   if (!isBleClientConnected)
      abortTransfers();
}

void handleFrame(uint8_t type, uint8_t seq, uint32_t key, const uint8_t *payload, uint16_t len) {
   lastFrameAt = millis();
   if (type == TYPE_HELLO) {
      char info[96];
      const int n = snprintf(info, sizeof(info), "{\"proto\":1,\"name\":\"%s\",\"baud\":%d}", CLIENT_ID, USB_LINK_BAUD);
      Serial.println("[USB] Session started");
      sendFrame(TYPE_HELLO | TYPE_ANSWER, seq, 0, (const uint8_t *)info, (uint16_t)n);
      Serial.flush();
      delay(20);
      Serial.updateBaudRate(USB_LINK_BAUD);
      sessionActive = true;
      return;
   }
   if (!sessionActive)
      return;

   if (type == TYPE_PING) {
      sendFrame(TYPE_PING | TYPE_ANSWER, seq, 0, nullptr, 0);
      return;
   }
   if (type == TYPE_BYE) {
      endSession();
      return;
   }

   NimBLECharacteristic *characteristic = find(key);
   const uint16_t wanted = (type == TYPE_READ) ? NIMBLE_PROPERTY::READ : (NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
   if ((type != TYPE_READ && type != TYPE_WRITE && type != TYPE_WRITE_NR) || characteristic == nullptr ||
       !(characteristic->getProperties() & wanted)) {
      const uint8_t reason = 1;
      if (type != TYPE_WRITE_NR)
         sendFrame(TYPE_ERROR, seq, key, &reason, 1);
      return;
   }

   if (type == TYPE_READ) {
      gattRead(characteristic, LINK_MTU);
      const NimBLEAttValue value = characteristic->getValue();
      sendFrame(TYPE_READ | TYPE_ANSWER, seq, key, value.data(), (uint16_t)value.length());
      return;
   }
   characteristic->setValue(payload, len);
   gattWrite(characteristic);
   if (type == TYPE_WRITE) {
      const uint8_t done = 0;
      sendFrame(TYPE_WRITE | TYPE_ANSWER, seq, key, &done, 1);
   }
}

void feed(uint8_t b) {
   switch (parseState) {
   case WAIT_START_0:
      if (b == START_0)
         parseState = WAIT_START_1;
      else if (!sessionActive)
         serialBootloaderByte(b);
      break;
   case WAIT_START_1:
      parseState = (b == START_1) ? READ_HEADER : ((b == START_0) ? WAIT_START_1 : WAIT_START_0);
      framePos = 0;
      break;
   case READ_HEADER:
      frame[framePos++] = b;
      if (framePos == HEADER_SIZE) {
         payloadLen = (uint16_t)(frame[2] | (frame[3] << 8));
         if (payloadLen > USB_LINK_MAX_PAYLOAD)
            parseState = WAIT_START_0; // not a frame
         else
            parseState = (payloadLen > 0) ? READ_PAYLOAD : READ_CRC;
      }
      break;
   case READ_PAYLOAD:
      frame[framePos++] = b;
      if (framePos == HEADER_SIZE + payloadLen)
         parseState = READ_CRC;
      break;
   case READ_CRC:
      frame[framePos++] = b;
      if (framePos == HEADER_SIZE + payloadLen + 4) {
         parseState = WAIT_START_0;
         const uint8_t *crcBytes = frame + HEADER_SIZE + payloadLen;
         const uint32_t crc = (uint32_t)crcBytes[0] | ((uint32_t)crcBytes[1] << 8) | ((uint32_t)crcBytes[2] << 16) | ((uint32_t)crcBytes[3] << 24);
         if (crc == crc32_le(0, frame, HEADER_SIZE + payloadLen)) {
            const uint32_t key = (uint32_t)frame[4] | ((uint32_t)frame[5] << 8) | ((uint32_t)frame[6] << 16) | ((uint32_t)frame[7] << 24);
            handleFrame(frame[0], frame[1], key, frame + HEADER_SIZE, payloadLen);
            lastFrameAt = millis(); // a long write is not silence
         }
      }
      break;
   }
}

void startListener();

// Runs for one session: its stack only costs memory while a client is connected.
void linkTask(void *) {
   static uint8_t buf[1024];
   while (!stopRequested && sessionActive) {
      const int available = Serial.available();
      if (available > 0) {
         const size_t n = Serial.read(buf, (available < (int)sizeof(buf)) ? (size_t)available : sizeof(buf));
         for (size_t i = 0; i < n; i++)
            feed(buf[i]);
      }
      else {
         if (sessionActive && millis() - lastFrameAt > USB_LINK_SESSION_TIMEOUT * 1000UL)
            endSession();
         vTaskDelay(1);
      }
   }
   endSession();
   task = nullptr;
   if (!stopRequested)
      startListener();
   vTaskDelete(nullptr);
}

// Waits for HELLO with a small stack, also while the main loop refreshes the display. Other
// bytes go to the bootloader command.
void listenTask(void *) {
   uint8_t buf[64];
   while (!stopRequested && !sessionActive) {
      const int available = Serial.available();
      if (available > 0) {
         const size_t n = Serial.read(buf, (available < (int)sizeof(buf)) ? (size_t)available : sizeof(buf));
         for (size_t i = 0; i < n && !sessionActive; i++)
            feed(buf[i]);
      }
      else {
         vTaskDelay(pdMS_TO_TICKS(10));
      }
   }
   if (sessionActive && !stopRequested && xTaskCreate(linkTask, "usb_link", 8192, nullptr, 2, &task) != pdPASS) {
      task = nullptr;
      Serial.println("[USB] ERROR: No memory for the session.");
      endSession();
   }
   listener = nullptr;
   vTaskDelete(nullptr);
}

void startListener() {
   if (listener == nullptr && xTaskCreate(listenTask, "usb_listen", 4096, nullptr, 2, &listener) != pdPASS) {
      listener = nullptr;
      Serial.println("[USB] ERROR: No memory to listen on the serial line.");
   }
}

} // namespace

namespace UsbLink {

void addService(NimBLEService *service) {
   for (NimBLECharacteristic *characteristic : service->getCharacteristics()) {
      if (entryCount >= MAX_CHARACTERISTICS)
         return;
      const std::string uuid = characteristic->getUUID().toString();
      entries[entryCount++] = {(uint32_t)strtoul(uuid.substr(0, 8).c_str(), nullptr, 16), characteristic};
   }
}

void begin() {
   if (task != nullptr || listener != nullptr)
      return;
   if (sendLock == nullptr)
      sendLock = xSemaphoreCreateMutex();
   stopRequested = false;
   parseState = WAIT_START_0;
   startListener();
}

void end() {
   stopRequested = true;
   for (int i = 0; i < 100 && (task != nullptr || listener != nullptr); i++)
      delay(5);
}

bool active() {
   return sessionActive;
}

uint32_t baudRate() {
   return sessionActive ? USB_LINK_BAUD : 115200;
}

void notify(NimBLECharacteristic *characteristic) {
   if (!sessionActive || characteristic == nullptr)
      return;
   for (int i = 0; i < entryCount; i++) {
      if (entries[i].characteristic == characteristic) {
         const NimBLEAttValue value = characteristic->getValue();
         sendFrame(TYPE_NOTIFY, 0, entries[i].key, value.data(), (uint16_t)value.length());
         return;
      }
   }
}

} // namespace UsbLink
