// The bar's HTTP API, for setting up a bar without busy-cli: read who it is, install our app, configure it.
//
// Every call takes an address ("10.0.4.20", "127.0.0.1:8640", or a full http:// URL) and, last, an optional
// { token }. Over USB (10.0.4.20) the API is open and needs no token; a wrong token is refused even there, so
// send one only when the bar's Wi-Fi API is password-protected. Failures throw an Error with a short message.
//
// Semantics follow the firmware (applications/services/web_server/http_api/api_apps.c, api_status.c, 1.3.1)
// and busy-cli's `app install` (stage, then install with the key it returns). No dependencies; Node 20+.

import { readFile } from "node:fs/promises";
import path from "node:path";

/** Small reads. The bar answers them in milliseconds; a long wait means it is not there. */
const QUICK_MS = 5000;
/** Launch and quit wait for the JS runtime to start or stop. */
const APP_MS = 15_000;
/** Upload and unpack of the package, busy-cli's own limit. */
const INSTALL_MS = 120_000;

/**
 * Who the bar is. Each field comes from one endpoint; a field the firmware does not report is null.
 *
 *   id         "busybar-<usb MAC, 12 lowercase hex digits>": the DNS-SD instance name the bar announces as
 *              `_http._tcp` (web_server.c). Stable across renames and Wi-Fi changes. null when the API has no
 *              usb_mac (the emulator). Not the mDNS hostname: that is the device name, lowercased, letters and
 *              digits only ("BUSY Bar" -> busybar.local), see `hostname`.
 *   name       device name, GET /api/name
 *   hostname   `${hostname}.local`, derived from name the way discovery.c does
 *   serial     GET /api/status/device serial_number (hex of the MCU UID)
 *   usbMac     "aa:bb:cc:dd:ee:ff" from status/device; the bar's USB network interface. wifiMac, bleMac likewise.
 *   model      OTP model, e.g. "BB.1"
 *   firmware   version string from GET /api/status/firmware, e.g. "1.3.1"; branch and commit beside it
 *   api        HTTP API semver, GET /api/version, e.g. "27.14.0"
 *   transport  "usb" | "wifi": how this request reached the bar, GET /api/transport
 *   wifi       { state, connected, ssid, address }: GET /api/wifi/status. state is the firmware's word
 *              ("connected", "disconnected", "connecting", ...); ssid and address only while connected.
 */
export async function barInfo(address, { token } = {}) {
  const opts = { token, timeoutMs: QUICK_MS };
  // The first call doubles as the "is there a bar at all" check, so its error is the one people see.
  const device = await call(address, "GET", "/api/status/device", opts);
  const [firmware, version, name, transport, wifi] = await Promise.all([
    call(address, "GET", "/api/status/firmware", opts).catch(() => ({})),
    call(address, "GET", "/api/version", opts).catch(() => ({})),
    call(address, "GET", "/api/name", opts).catch(() => ({})),
    call(address, "GET", "/api/transport", opts).catch(() => ({})),
    // Fails when the bar has no Wi-Fi service running; that is "not connected", not an error.
    call(address, "GET", "/api/wifi/status", opts).catch(() => ({ state: "unavailable" })),
  ]);
  const usbMac = str(device.usb_mac);
  const deviceName = str(name.name);
  const hostname = deviceName ? deviceName.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "busybar" : null;
  const connected = wifi.state === "connected";
  return {
    id: usbMac ? `busybar-${usbMac.replace(/[^0-9a-f]/gi, "").toLowerCase()}` : null,
    name: deviceName,
    hostname: hostname && `${hostname}.local`,
    serial: str(device.serial_number),
    usbMac,
    wifiMac: str(device.wifi_mac),
    bleMac: str(device.ble_mac),
    model: str(device.otp_model),
    firmware: str(firmware.version),
    branch: str(firmware.branch),
    commit: str(firmware.commit_hash),
    api: str(version.api_semver),
    // The firmware says {type}, the emulator {interface}.
    transport: str(transport.type ?? transport.interface),
    wifi: {
      state: str(wifi.state),
      connected,
      ssid: connected ? str(wifi.ssid) : null,
      address: connected ? str(wifi.ip_config?.address) : null,
    },
  };
}

/**
 * Installs a .tgz built by busy-cli, replacing the installed version. Returns { id, name, version, replaced }
 * where replaced is the version that was there before, or null.
 *
 * The firmware cannot replace an app that is running and playing an .anim ("Cannot delete app"), so when the
 * package replaces an installed app, the running app is quit first. The API cannot tell which app runs, and quit
 * stops whatever does; a fresh install skips it, since an app that is not installed cannot be running.
 */
export async function installApp(address, tgzPath, { token } = {}) {
  let body;
  try {
    body = await readFile(tgzPath);
  } catch (err) {
    throw new Error(`Cannot read ${path.basename(tgzPath)}: ${err.code ?? err.message}`);
  }
  const { install_key, staged, installed } = await call(address, "POST", "/api/apps/stage", {
    token,
    body,
    timeoutMs: INSTALL_MS,
  });
  if (!install_key || !staged?.id) throw new Error("The bar staged the package but sent no install key");
  if (installed) await quit(address, token);
  await call(address, "POST", "/api/apps/install", { token, query: { install_key }, timeoutMs: INSTALL_MS });
  return { id: staged.id, name: staged.name, version: staged.version, replaced: installed?.version ?? null };
}

/** Starts an installed app, in front of whatever runs. The app reads its settings only now, so launch after a change. */
export async function launchApp(address, appId, { token } = {}) {
  await call(address, "POST", "/api/apps/launch", { token, query: { app_id: appId }, timeoutMs: APP_MS });
}

/**
 * Quits the running app. Returns true if one was stopped, false if nothing ran. The firmware's quit takes no app id
 * and the API does not say which app runs, so this stops whatever runs; appId only names what the caller means.
 */
export async function stopApp(address, appId, { token } = {}) {
  return quit(address, token);
}

/** The app's current settings values, e.g. { host, token, context_bar }; defaults until something was saved. */
export async function appSettings(address, appId, { token } = {}) {
  const doc = await settingsDocument(address, appId, token);
  return { ...doc.values };
}

/**
 * Changes some settings and keeps the rest. The firmware accepts only a whole document ({version, values} with every
 * field valid) and answers 400 otherwise, so this reads it, merges, and writes it back. A key the app's schema does
 * not have would be dropped without a word, so it is refused here. Returns the values now saved.
 * A running app sees the change only after it is launched again.
 */
export async function setAppSettings(address, appId, values, { token } = {}) {
  const doc = await settingsDocument(address, appId, token);
  const unknown = Object.keys(values).filter((key) => !(key in doc.values));
  if (unknown.length) throw new Error(`${appId} has no setting ${unknown.join(", ")}`);
  const next = { ...doc, values: { ...doc.values, ...values } };
  await call(address, "PUT", "/api/apps/settings", {
    token,
    query: { app_id: appId },
    body: JSON.stringify(next),
    contentType: "application/json",
    timeoutMs: QUICK_MS,
  });
  return { ...next.values };
}

async function settingsDocument(address, appId, token) {
  const doc = await call(address, "GET", "/api/apps/settings", { token, query: { app_id: appId }, timeoutMs: QUICK_MS });
  if (!doc || typeof doc.values !== "object") throw new Error(`The bar sent no settings for ${appId}`);
  return doc;
}

/** POST /api/apps/quit; its 409 means nothing was running. */
async function quit(address, token) {
  try {
    await call(address, "POST", "/api/apps/quit", { token, timeoutMs: APP_MS });
    return true;
  } catch (err) {
    if (err.status === 409) return false;
    throw err;
  }
}

/** What a bare status means where the firmware gives no reason of its own, per endpoint (api_apps.c). */
const MEANINGS = {
  "/api/apps/stage": { 400: "the bar rejected the package", 413: "the package is too large", 508: "the bar's storage is full" },
  "/api/apps/install": { 400: "the bar did not install the app; quit the running app and try again" },
  "/api/apps/launch": { 400: "invalid app id", 404: "the app is not installed", 503: "the bar failed to launch the app" },
  "/api/apps/settings": { 400: "invalid settings", 404: "the app is not installed or has no settings" },
};

/** One request to the bar; resolves to the parsed JSON body (or text). Throws Error with .status on HTTP errors. */
async function call(address, method, apiPath, { token, query, body, contentType, timeoutMs = QUICK_MS } = {}) {
  const url = new URL(apiPath, baseUrl(address));
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const headers = {};
  if (token) headers["X-API-Token"] = token;
  if (body) headers["Content-Type"] = contentType ?? "application/octet-stream";
  let res;
  let text;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    if (res) throw new Error(`${method} ${apiPath}: the bar closed the connection (HTTP ${res.status})`);
    throw new Error(`No BUSY Bar at ${url.host} (${why(err, timeoutMs)})`);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const said = typeof data?.error === "string" && data.error && !/^(Bad Request|Not Found)$/i.test(data.error) ? data.error : null;
    const meaning = MEANINGS[apiPath]?.[res.status];
    const reason = [said, meaning].filter(Boolean).join(": ") || res.statusText || "error";
    const access = res.status === 403 ? " (the bar's Wi-Fi API wants a token, or the token is wrong)" : "";
    const err = new Error(`${method} ${apiPath}: ${reason}${access} (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function baseUrl(address) {
  try {
    return new URL(/^https?:\/\//.test(address) ? address : `http://${address}`);
  } catch {
    throw new Error(`Invalid bar address: ${address}`);
  }
}

function why(err, timeoutMs) {
  if (err?.name === "TimeoutError") return `no answer within ${timeoutMs / 1000} s`;
  const code = err?.cause?.code ?? err?.code;
  const words = { ECONNREFUSED: "connection refused", EHOSTUNREACH: "host unreachable", ENETUNREACH: "network unreachable", ENOTFOUND: "unknown host", ECONNRESET: "connection reset" };
  return words[code] ?? code ?? err?.cause?.message ?? err?.message ?? "no answer";
}

const str = (value) => (typeof value === "string" && value !== "" ? value : null);
