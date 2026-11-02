// Setup for a new computer and bar, and the small jobs around it, for claude-bar-daemon.mjs.
//
// setup: finds the bar (over the USB cable, where its API is always open, or on Wi-Fi), installs the prebuilt app
// on it, writes the app's settings (this computer's addresses and the token), starts the daemon, and asks the
// person to press Start on the bar: that answer proves the whole loop, bar → computer → bar, works.
// ensure: starts the daemon in the background unless the same version already runs. The plugin's SessionStart
// hook calls it, so the daemon is up whenever Claude Code is, with no login items or services to install.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { barInfo, installApp, launchApp, setAppSettings } from "./bar-api.mjs";
import { findBars } from "./mdns.mjs";

const APP_ID = "app.busy.claude_code";
/** Over the USB cable the bar and the computer always have these addresses. */
const USB_BAR = "10.0.4.20";
const USB_COMPUTER = "10.0.4.21";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, "claude-bar-daemon.mjs");
const BUNDLE = path.join(HERE, "..", "release", `${APP_ID}.tgz`);
/** Windows keeps incoming connections out unless a rule lets them in; this is ours. */
const FIREWALL_RULE = "ClaudeCodeBusyBar";

/** A short hash of a file: the daemon's version, so a changed daemon replaces the one left running. */
export function codeVersion(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
}

async function ping(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the daemon in the background unless this version already runs. With `restart`, always starts afresh. */
export async function ensure({ port, version, configDir, restart = false }) {
  const running = await ping(port);
  if (running && running.version === version && !restart) return true;
  if (running) {
    await fetch(`http://127.0.0.1:${port}/quit`, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(() => {});
    for (let i = 0; i < 20 && (await ping(port)); i++) await sleep(100);
  }
  mkdirSync(configDir, { recursive: true });
  const log = openSync(path.join(configDir, "daemon.log"), "a");
  spawn(process.execPath, [DAEMON], { detached: true, stdio: ["ignore", log, log], windowsHide: true }).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if ((await ping(port))?.version === version) return true;
  }
  return false;
}

const say = (text) => console.log(text);

/** This computer's IPv4 addresses on the bar's Wi-Fi network: the ones the bar can call. */
function addressesNear(barAddress) {
  const toNumber = (a) => a.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .filter((a) => (toNumber(a.address) & toNumber(a.netmask)) === (toNumber(barAddress) & toNumber(a.netmask)))
    .map((a) => a.address);
}

function hasAddress(address) {
  return Object.values(os.networkInterfaces()).flat().some((a) => a?.address === address);
}

/** Finds a bar whose API answers: over the cable first, then any announced on Wi-Fi (their API may be closed). */
async function findBar() {
  try {
    return { address: USB_BAR, info: await barInfo(USB_BAR), usb: true };
  } catch {
    // No cable, or another bar; look on Wi-Fi.
  }
  const announced = await findBars({ timeoutMs: 3000 }).catch(() => []);
  for (const bar of announced) {
    try {
      return { address: bar.address, info: await barInfo(bar.address), usb: false };
    } catch {
      // Its API is closed over Wi-Fi (the default); the cable is the way in.
    }
  }
  return { announced };
}

/** Windows: lets the bar's calls in. Asks for administrator rights once, through the usual Windows prompt. */
function allowThroughFirewall(port) {
  if (process.platform !== "win32") return;
  const shown = spawnSync("netsh", ["advfirewall", "firewall", "show", "rule", `name=${FIREWALL_RULE}`], { encoding: "utf8" });
  if (shown.status === 0) return;
  say(`Windows will ask to let the bar reach this computer on port ${port}. Click Yes.`);
  const rule = `advfirewall firewall add rule name=${FIREWALL_RULE} dir=in action=allow protocol=TCP localport=${port} profile=any`;
  spawnSync("powershell", ["-NoProfile", "-Command", `Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${rule}'`], {
    stdio: "inherit",
  });
}

/** True when the plugin runs this file: its hooks then come with the plugin, not from settings.json. */
const fromPlugin = () => HERE.split(path.sep).join("/").includes("/.claude/plugins/");

/** @returns {Promise<number>} the exit code */
export async function setup({ port, version, config, saveConfig, paths }) {
  say("Looking for the BUSY Bar...");
  const found = await findBar();
  if (!found.info) {
    if (found.announced?.length) {
      say(`Found ${found.announced.map((b) => b.name || b.id).join(", ")} on Wi-Fi, but a bar only lets a computer set it up over the cable.`);
    }
    say("Connect the bar to this computer with a USB cable, then run setup again.");
    return 1;
  }
  const { address, info } = found;
  say(`Bar: ${info.name || info.id} (${info.serial}), firmware ${info.firmware}`);

  // The addresses the bar will call: this computer on the bar's Wi-Fi, and over the cable.
  const wifi = info.wifi?.connected ? info.wifi.address : null;
  const hosts = [...(wifi ? addressesNear(wifi) : []), ...(hasAddress(USB_COMPUTER) ? [USB_COMPUTER] : [])];
  if (hosts.length === 0) {
    say("The bar and this computer share no network. Connect the bar to the same Wi-Fi (BUSY app) or by cable.");
    return 1;
  }
  if (!wifi) say("The bar is not on Wi-Fi, so it will only work over the cable. Connect it to Wi-Fi in the BUSY app and run setup again.");
  else if (!addressesNear(wifi).length) say(`The bar is on Wi-Fi "${info.wifi.ssid}", but this computer is not; it will only work over the cable.`);

  config.paired = { id: info.id, name: info.name, serial: info.serial };
  config.bars = [...new Set([...config.bars, USB_BAR, ...(wifi ? [wifi] : [])])];
  saveConfig();
  allowThroughFirewall(port);
  // Restart, so the running daemon knows the bar's addresses saved just now.
  if (!(await ensure({ port, version, configDir: paths.configDir, restart: true }))) {
    say(`The daemon did not start. Its log: ${path.join(paths.configDir, "daemon.log")}`);
    return 1;
  }

  say("Installing the app on the bar...");
  if (!existsSync(BUNDLE)) {
    say(`The app bundle is missing: ${BUNDLE}`);
    return 1;
  }
  try {
    await installApp(address, BUNDLE);
  } catch (err) {
    say(`Could not install the app: ${err.message}`);
    if (/404/.test(err.message)) say("This bar's firmware has no apps yet. Update it to 1.3.1 or newer in the BUSY app.");
    return 1;
  }
  // The app reads its settings only when it starts, so it is launched after they are written.
  await setAppSettings(address, APP_ID, { host: hosts.map((h) => `${h}:${port}`).join(","), token: config.token });
  await launchApp(address, APP_ID);

  say("Now press Start on the bar.");
  const res = await fetch(`http://127.0.0.1:${port}/setup-test`, { method: "POST", signal: AbortSignal.timeout(130_000) });
  const { answer, barSeen } = await res.json();
  if (!barSeen) {
    say("The bar can't reach this computer.");
    if (process.platform === "win32") say("Check Windows Firewall: Node.js may have Block rules from an earlier prompt.");
    say(`It calls ${hosts.join(" or ")} on port ${port}. A firewall or a guest Wi-Fi network can stand in the way.`);
    return 1;
  }
  if (answer === "dismiss") {
    say("The bar is connected, but Start was not pressed in time. Run setup again to retry the test.");
    return 1;
  }

  say("Done: the bar shows your Claude Code sessions and answers permission prompts.");
  if (wifi && addressesNear(wifi).length) say(`It works over Wi-Fi "${info.wifi.ssid}"; you can unplug the cable.`);
  if (fromPlugin()) {
    // The plugin brings its own hooks; old ones from --install-hooks would make every event arrive twice.
    removeSettingsHooks(paths.settings, `http://127.0.0.1:${port}/hook`);
  } else if (!hooksInstalled(paths.settings, port)) {
    say("Claude Code doesn't send its events here yet: install the busybar plugin, or run this daemon with --install-hooks.");
  }
  return 0;
}

/** Takes our hooks out of settings.json, keeping a dated backup. */
function removeSettingsHooks(settingsPath, hookUrl) {
  if (!existsSync(settingsPath)) return;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.filter((group) => !group.hooks?.some((h) => h.type === "http" && h.url === hookUrl));
    removed += groups.length - kept.length;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!removed) return;
  const backup = `${settingsPath}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  copyFileSync(settingsPath, backup);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  say(`Old hooks removed from ${settingsPath} (backup: ${backup}).`);
}

function hooksInstalled(settingsPath, port) {
  try {
    return readFileSync(settingsPath, "utf8").includes(`127.0.0.1:${port}/hook`);
  } catch {
    return false;
  }
}

/** Stops the daemon and removes our hooks from settings.json and our config. The plugin and the app stay. */
export async function uninstall({ port, paths, hookUrl }) {
  await fetch(`http://127.0.0.1:${port}/quit`, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(() => {});
  say("Daemon stopped.");
  removeSettingsHooks(paths.settings, hookUrl);
  rmSync(paths.configDir, { recursive: true, force: true });
  say(`Removed ${paths.configDir}.`);
  say("To remove the rest: /plugin uninstall busybar in Claude Code, and delete the app on the bar in the BUSY app.");
  return 0;
}
