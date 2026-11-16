#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>

// The functions of the Bluetooth interface over the USB serial line (README, "USB link").
// A client reads, writes and is notified of the same characteristics, carried in frames.

#define USB_LINK_BAUD 921600
#define USB_LINK_RX_BUFFER 4096       // 40 ms at USB_LINK_BAUD
#define USB_LINK_MAX_PAYLOAD 512      // largest value of a characteristic
#define USB_LINK_SESSION_TIMEOUT 20   // seconds without a frame until the session ends

namespace UsbLink {

void addService(NimBLEService *service); // characteristics a client may use
void begin();                            // setup mode: listen on the serial line
void end();
bool active(); // a client has opened a session
uint32_t baudRate(); // speed of the serial line now
void notify(NimBLECharacteristic *characteristic);

} // namespace UsbLink
