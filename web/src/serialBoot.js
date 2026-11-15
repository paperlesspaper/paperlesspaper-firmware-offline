// USB flashing without the boot button, and a check of what starts after flashing.
//
// The board has no auto reset. Both firmwares restart into the ROM bootloader when they receive
// "B" on the serial line while they start (the offline firmware also while it is in setup mode).

import { ESPLoader, Transport } from "esptool-js";

const BAUD = 115200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens the port and reads its text until `evaluate(log)` returns a result or the time is up.
 * `send`: bytes that are written every 100 ms meanwhile.
 */
async function listen(port, { timeoutMs, send = null, evaluate }) {
  await port.open({ baudRate: BAUD });
  const reader = port.readable.getReader();
  const writer = send ? port.writable.getWriter() : null;
  const sender = writer ? setInterval(() => writer.write(send).catch(() => {}), 100) : null;
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let log = "";
  let result;
  let pending = null;
  try {
    while (result === undefined && Date.now() < deadline) {
      pending = pending || reader.read();
      const chunk = await Promise.race([pending, sleep(200).then(() => null)]);
      if (chunk) {
        pending = null;
        if (chunk.done) break;
        log = (log + decoder.decode(chunk.value, { stream: true })).slice(-20000);
      }
      result = evaluate(log);
    }
  } finally {
    clearInterval(sender);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (writer) writer.releaseLock();
    await port.close().catch(() => {});
  }
  return result;
}

/** true if the ROM bootloader already answers (boot button held during a reset). */
export async function bootloaderAnswers(port, terminal) {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: BAUD, terminal });
  try {
    await loader.connect("no_reset", 1, false);
    return true;
  } catch (e) {
    return false;
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

/**
 * Asks the firmware to restart into the bootloader. The user presses reset once.
 * Resolves to "entered", "unsupported" (a firmware started that does not know the command)
 * or "silent" (nothing was heard).
 */
export async function requestBootloader(port, timeoutMs = 60000) {
  let bootSeenAt = 0;
  const result = await listen(port, {
    timeoutMs,
    send: new TextEncoder().encode("B"),
    evaluate: (log) => {
      if (/ROM Download Bootloader|waiting for download/.test(log)) return "entered";
      if (log.includes("[MAIN] INIT Device V:")) {
        bootSeenAt = bootSeenAt || Date.now();
        if (Date.now() - bootSeenAt > 8000) return "unsupported";
      }
      return undefined;
    },
  });
  return result || "silent";
}

/**
 * Waits for the next start of the device and reads its boot log.
 * Resolves to { version, offline, slot } or null if the device did not start in time.
 * slot: "app0" / "app1", null if the firmware does not report it.
 */
export async function readBootLog(port, timeoutMs = 60000) {
  let versionSeenAt = 0;
  const result = await listen(port, {
    timeoutMs,
    evaluate: (log) => {
      const start = log.lastIndexOf("[MAIN] INIT Device V:");
      if (start < 0) return undefined;
      versionSeenAt = versionSeenAt || Date.now();
      const boot = log.slice(start);
      // The lines that tell the firmwares apart follow the version; the device id comes after them.
      if (!boot.includes("[MAIN] UID:") && Date.now() - versionSeenAt < 4000) return undefined;
      const version = /\[MAIN\] INIT Device V:\s*(\S+)/.exec(boot);
      const slot = /\[MAIN\] App slot:\s*(\w+)/.exec(boot);
      return { version: version ? version[1] : "", offline: boot.includes("[MAIN] FW: offline"), slot: slot ? slot[1] : null };
    },
  });
  return result || null;
}
