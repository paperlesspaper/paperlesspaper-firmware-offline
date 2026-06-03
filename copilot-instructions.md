# Paperlesspaper Firmware Offline - Copilot Instructions

## Projektübersicht

Dies ist eine "Offline-first" Firmware für ein ESP32-C6-basiertes E-Paper-Display (Spectra 6 7.3").
Das System besteht aus zwei Hauptkomponenten:

1. **Der Firmware (`src/`)**: Ein C++ PlatformIO-Projekt basierend auf dem Arduino-Framework.
2. **Dem Web-UI (`web/`)**: Einem Vite-basierten Web-Frontend (HTML/TailwindCSS/JS), das über Web-BLE (Bluetooth Low Energy) direkt mit dem ESP32 kommuniziert.

---

## 1. Kontext- und Datei-Regeln

- **Ganzheitlicher Kontext:** Wenn du Änderungen an der Kommunikation oder Steuerung vornimmst, prüfe immer **beide Seiten**: das Frontend (`web/src/index.html`, `web/src/app.js`) und die Firmware (`src/main.cpp`).
- Nutze aktiv Werkzeuge zum Lesen der Dateien, wenn du mehr Kontext zum Verhalten von BLE-Charakteristiken (NimBLE) oder Web-UI-Logik (Web Bluetooth API) benötigst.

---

## 2. Firmware-Richtlinien (`src/`)

- **Hardware:** ESP32-C6, Spectra 6 7.3" (GxEPD2 Bibliotheken), KXTJ3-1057 Accelerometer.
- **BLE Kommunikation:** Wird über `NimBLEDevice` abgewickelt. Es gibt spezifische Services für WLAN-Setup, Downloads, Settings und direkte Bild-Uploads (Upload Buffer).
- **Betriebsmodi:**
  - _Setup Mode_: Wird über 1x Reset-Taste gestartet (aktiviert BLE).
  - _WiFi Download Mode_: HTTP(s) Download eines Bildes nach dem Aufwachen.
  - _Deep Sleep / Wakeup_: Timer, Motion (Accelerometer), oder Button.
- **Speicher:** Beachte stets das definierte EEPROM/Flash Memory Map (z. B. WLAN `0-105`, Settings ab `500+`), wenn Variablen dauerhaft gespeichert werden sollen.

---

## 3. Web-UI-Richtlinien (`web/`)

- Das Web-Interface ist absichtlich simpel gehalten (Vanilla JS `app.js` + Tailwind CSS in `index.html`), keine Frameworks wie React/Vue.
- **Formatierungs-Regeln für HTML/JS (`web/`):**
  - **Prettier Settings:** `printWidth: 2000`, `tabWidth: 4`, `singleQuote: true`, `htmlWhitespaceSensitivity: ignore`.
  - **HTML Besonderheit:** In der `index.html` stehen `<!doctype html>`, `<html>`, `<head>` und `<body>` **nichteingerückt (flush-left)** am Zeilenanfang. Modifiziere diese Struktur niemals, sie muss exakt so beibehalten werden, da Prettier dies sonst fälschlicherweise auto-einrücken würde. Es dürfen keine zusätzlichen Zeilenumbrüche zwischen Klassenattributen (Tailwind) auftauchen.
  - **JavaScript:** Verwende einfache Anführungszeichen (`'`) für Strings (außer dort, wo HTML/Doppelzitate notwendig sind).
- **Image Processing:** Für Dithering/Bildverarbeitung wird `epdoptimize` genutzt. Liefere stets Code, der gut mit dem Canvas-Preview im UI harmoniert.

---

## 4. Kommunikation und Verhalten (Sehr wichtig!)

- **Rückfragen stellen:** Wenn Anforderungen unklar, mehrdeutig oder lückenhaft sind, triff keine weitreichenden Annahmen. **Stelle stattdessen klärende Gegenfragen**
- **Keine Zerstörung durch Formatter:** Wenn du Codeblöcke ausgibst oder Dateien bearbeitest (besonders die `index.html`), achte akribisch auf die geforderten Whitespace-Sonderregeln.
- Erkläre BLE- und Hardware-Besonderheiten für den Benutzer stets klar nachvollziehbar, wenn du Code dazu generierst.
