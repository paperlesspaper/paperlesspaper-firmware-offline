// Generic UI helpers: status dock, progress, navigation, dialogs, collapsibles.
// No device logic in here – see app.js.

export const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Status LED
// ---------------------------------------------------------------------------

/** Semantic status levels used across the app (instead of colour class names). */
const LED_CLASS = {
  idle: "state-0",
  err: "state-1",
  busy: "state-2",
  ok: "state-3",
  warn: "state-warn",
};

export function setLed(el, level) {
  if (!el) return;
  el.classList.remove(...Object.values(LED_CLASS));
  el.classList.add(LED_CLASS[level] || LED_CLASS.idle);
}

// ---------------------------------------------------------------------------
// Status line + log
// ---------------------------------------------------------------------------

const statusEl = $("status");
const statusLed = $("statusLed");
const statusLogOutput = $("statusLogOutput");
const dockLogToggle = $("dockLogToggle");
const dockLog = $("dockLog");

const MAX_LOG_LINES = 300;
const LOG_PREFIX = { err: "✗", warn: "!", ok: "✓" };

export const currentStatus = { text: "", level: "idle" };
const statusListeners = new Set();
let lastLogNode = null;
let lastLogKey = "";

function appendLog(text, level) {
  if (!statusLogOutput) return;
  const stamp = new Date().toLocaleTimeString("de-DE", { hour12: false });
  const line = `[${stamp}] ${LOG_PREFIX[level] || " "} ${text}\n`;
  // Progress updates ("… 45%") overwrite their previous line instead of flooding the log.
  const key = text.replace(/\d+([.,]\d+)?/g, "#");
  if (lastLogNode && key === lastLogKey && key.includes("#%")) {
    lastLogNode.textContent = line;
  } else {
    lastLogNode = document.createTextNode(line);
    statusLogOutput.append(lastLogNode);
    while (statusLogOutput.childNodes.length > MAX_LOG_LINES) {
      statusLogOutput.firstChild.remove();
    }
  }
  lastLogKey = key;
  statusLogOutput.scrollTop = statusLogOutput.scrollHeight;
}

/**
 * Sets the one persistent status line.
 * @param {string} text
 * @param {"idle"|"busy"|"ok"|"warn"|"err"} level
 */
export function setStatus(text, level = "idle") {
  const message = String(text ?? "");
  currentStatus.text = message;
  currentStatus.level = level;
  if (statusEl) statusEl.textContent = message;
  setLed(statusLed, level);
  appendLog(message, level);
  statusListeners.forEach((fn) => fn(message, level));
}

export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

if (dockLogToggle && dockLog) {
  dockLogToggle.addEventListener("click", () => {
    const open = dockLog.hidden;
    dockLog.hidden = !open;
    dockLogToggle.setAttribute("aria-expanded", String(open));
    if (open) statusLogOutput.scrollTop = statusLogOutput.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const dockProgress = $("dockProgress");
const dockProgressFill = $("dockProgressFill");
const dockPercent = $("dockPercent");
const progressListeners = new Set();

/** @param {number|null} percent 0-100, or null to hide the progress display */
export function setProgress(percent) {
  const active = typeof percent === "number" && Number.isFinite(percent);
  const value = active ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  if (dockProgress) dockProgress.hidden = !active;
  if (dockPercent) dockPercent.hidden = !active;
  if (active) {
    dockProgressFill.style.width = value + "%";
    dockPercent.textContent = value + "%";
  }
  progressListeners.forEach((fn) => fn(value));
}

export function onProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Navigation (hash based, so the browser back button works)
// ---------------------------------------------------------------------------

const VIEW_IDS = {
  bild: "viewEditor",
  geraet: "viewConnect",
  firmware: "viewOta",
  hilfe: "viewHelp",
};
const DEFAULT_VIEW = "bild";
let currentView = null;

function viewFromHash() {
  const name = decodeURIComponent(location.hash.replace(/^#/, ""));
  return VIEW_IDS[name] ? name : null;
}

function showView(name) {
  if (!VIEW_IDS[name]) name = DEFAULT_VIEW;
  if (name === currentView) return;
  currentView = name;
  for (const [key, id] of Object.entries(VIEW_IDS)) {
    const el = $(id);
    if (el) el.hidden = key !== name;
  }
  document.querySelectorAll("[data-view-target]").forEach((btn) => {
    if (btn.dataset.viewTarget === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
}

export function getCurrentView() {
  return currentView;
}

/** Switches the view immediately and records it in the history. */
export function navigate(name) {
  if (!VIEW_IDS[name]) return;
  showView(name);
  if (viewFromHash() !== name) location.hash = name;
}

export function initNavigation() {
  document.querySelectorAll("[data-view-target]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.viewTarget));
  });
  window.addEventListener("hashchange", () => {
    const name = viewFromHash();
    // Unknown hashes (e.g. the skip link's #main) must not switch the view.
    if (name || !location.hash) showView(name || DEFAULT_VIEW);
  });
  showView(viewFromHash() || DEFAULT_VIEW);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

export function openDialog(dlg) {
  if (dlg && !dlg.open) dlg.showModal();
}

export function closeDialog(dlg) {
  if (dlg && dlg.open) dlg.close();
}

/** Tap on the scrim closes a dialog (the content fills the dialog, so target === dialog means scrim). */
export function initDialogs() {
  document.querySelectorAll("dialog.modal").forEach((dlg) => {
    let downOnScrim = false;
    dlg.addEventListener("pointerdown", (e) => {
      downOnScrim = e.target === dlg;
    });
    dlg.addEventListener("click", (e) => {
      if (downOnScrim && e.target === dlg) dlg.close();
      downOnScrim = false;
    });
  });
}

const messageDialog = $("messageDialog");
const messageTitle = $("messageTitle");
const messageText = $("messageText");
const messageDetail = $("messageDetail");
const messageOk = $("messageOk");
const messageCancel = $("messageCancel");
let messageQueue = Promise.resolve();

/**
 * Alert / confirmation dialog (replaces native alert() and confirm()).
 * Resolves to true when the affirmative button was pressed.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.text]
 * @param {string} [opts.detail]   concrete data shown in a message box
 * @param {"neutral"|"warn"|"err"} [opts.tone]
 * @param {string} [opts.okLabel]
 * @param {string|null} [opts.cancelLabel]  null = plain alert with a single button
 * @param {"primary"|"signal"|"danger"} [opts.okVariant]
 */
export function showMessage({ title, text = "", detail = "", tone = "neutral", okLabel = "OK", cancelLabel = null, okVariant = "primary" }) {
  const run = () =>
    new Promise((resolve) => {
      messageTitle.textContent = (tone === "neutral" ? "" : "⚠️ ") + title;
      messageTitle.classList.toggle("is-err", tone === "err");
      messageText.textContent = text;
      messageText.hidden = !text;
      messageDetail.textContent = detail;
      messageDetail.hidden = !detail;
      messageDetail.className = "message-box" + (tone === "err" ? " tint-err" : tone === "warn" ? " tint-warn" : "");
      messageOk.textContent = okLabel;
      messageOk.className = `btn-neu btn-grow btn-neu-${okVariant}`;
      messageCancel.textContent = cancelLabel || "";
      messageCancel.hidden = !cancelLabel;
      messageDialog.returnValue = "";
      messageDialog.addEventListener("close", () => resolve(messageDialog.returnValue === "ok"), { once: true });
      messageDialog.showModal();
      // Destructive confirmations start on the safe button.
      (okVariant === "danger" && cancelLabel ? messageCancel : messageOk).focus();
    });
  const result = messageQueue.then(run, run);
  messageQueue = result.catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------
// Collapsibles
// ---------------------------------------------------------------------------

export function setCollapsible(el, open) {
  if (!el) return;
  el.classList.toggle("open", open);
  const head = el.querySelector(":scope > .collapsible-head");
  if (head) head.setAttribute("aria-expanded", String(open));
}

export function initCollapsibles() {
  document.querySelectorAll("[data-collapsible]").forEach((el) => {
    const head = el.querySelector(":scope > .collapsible-head");
    if (!head) return;
    head.addEventListener("click", () => setCollapsible(el, !el.classList.contains("open")));
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Lets the browser paint (e.g. a busy state) before heavy synchronous work starts. */
export function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 120); // background tabs do not run requestAnimationFrame
  });
}

export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

/** Shows or clears the validation message below an input (expects an element with id `<inputId>Error`). */
export function setFieldError(input, message) {
  if (!input) return;
  const errorEl = $(input.id + "Error");
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  if (errorEl) {
    errorEl.textContent = message ? "✗ " + message : "";
    errorEl.hidden = !message;
  }
}

/** "3600" -> "1 Std." – human readable form of a duration in seconds. */
export function formatDuration(totalSeconds) {
  const s = Math.floor(Number(totalSeconds));
  if (!Number.isFinite(s) || s <= 0) return "";
  const parts = [];
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (days) parts.push(`${days} ${days === 1 ? "Tag" : "Tage"}`);
  if (hours) parts.push(`${hours} Std.`);
  if (minutes) parts.push(`${minutes} Min.`);
  if (seconds && !days) parts.push(`${seconds} Sek.`);
  return parts.join(" ");
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
