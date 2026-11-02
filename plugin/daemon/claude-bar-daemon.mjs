#!/usr/bin/env node
// Claude Code on the BUSY Bar: the Mac side.
//
//   node daemon/claude-bar-daemon.mjs [--port 8790] [--bar 10.0.4.20] [--hold 590]
//   node daemon/claude-bar-daemon.mjs --print-hooks      the hooks block for ~/.claude/settings.json
//   node daemon/claude-bar-daemon.mjs --install-hooks    adds it there, after a backup
//   node daemon/claude-bar-daemon.mjs --demo             made-up sessions, for filming without real work
//   node daemon/claude-bar-daemon.mjs setup              finds the bar, installs the app on it, pairs them (setup.mjs)
//   node daemon/claude-bar-daemon.mjs uninstall          stops the daemon and takes out what setup and --install-hooks put in
//   node daemon/claude-bar-daemon.mjs --ensure           starts the daemon in the background unless it already runs; silent
//
// Claude Code posts every session event here through global `http` hooks. The daemon keeps a small picture of
// all sessions and serves it to the bar app, which also sends back the answers to permission prompts.
//
// POST /hook                 from Claude Code on this Mac (loopback only). A PermissionRequest is held open until
//                            the bar answers, the prompt is answered in the terminal, or --hold seconds pass.
// GET  /state?v=<version>    from the bar: the current picture. Waits up to 3 s for a newer version than v.
// POST /answer               from the bar: {"id": <prompt id>, "answer": "allow" | "deny" | "dismiss"}
// GET  /ping, POST /quit     from this Mac: which daemon runs, and stop it (setup and --ensure use them)
// POST /setup-test           from this Mac: a "press Start" prompt on the bar; answers once it is pressed
//
// The bar must send the token (`Authorization: Bearer <token>` or `?token=`) and come from an allowed address:
// an "allow" runs a command on this Mac, so nobody else on the network may send one. When the paired bar gets a
// new Wi-Fi address, a request with the right token from it is let in once mDNS confirms the address is that bar.
// No dependencies; Node 20+.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { findBars } from "./mdns.mjs";
import { codeVersion, ensure, setup, uninstall } from "./setup.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

// Started without a console (on Windows, see startOnWindows in setup.mjs), the daemon writes its log itself.
const LOG_FILE = option("--log", null);
if (LOG_FILE) {
  const out = createWriteStream(LOG_FILE, { flags: "a" });
  console.log = console.error = (...parts) => out.write(format(...parts) + "\n");
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "busy-claude-bar");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

const config = loadConfig();
const PORT = Number(option("--port", config.port));
/** Addresses the bar may call from. Over USB the bar is 10.0.4.20; add its Wi-Fi address with --bar. */
const BAR_ADDRESSES = new Set([...config.bars, ...args.flatMap((a, i) => (args[i - 1] === "--bar" ? [a] : []))]);
/** A prompt is let go this long after it arrived, so Claude Code's own hook timeout (600 s) never fires first. */
const HOLD_S = Number(option("--hold", 590));
/** Long-poll: how long GET /state waits for news. The bar's fetch gives up after 5 s of silence. */
const POLL_WAIT_MS = 3000;
/** Activity lines ("Edit client.ts") change many times a second; the bar hears about them at most this often. */
const ACTIVITY_EVERY_MS = 1000;
/** How often running sessions' transcripts are checked for an interrupt and for context use. */
const TRANSCRIPT_EVERY_MS = 2000;
/** A session that has said nothing for this long is dropped: its terminal was most likely closed. */
const FORGET_AFTER_MS = 12 * 3600 * 1000;
/** Longest command shown in the approval marquee, in characters. */
const PROMPT_TEXT_MAX = 140;
/** Longest activity line ("Bash npm test ..."): it only says what is going on, the prompt is where details matter. */
const DOING_MAX = 60;
/** The snapshot's shape. The bar app shows "Update app" when the daemon is newer than it understands. */
const API_VERSION = 1;
/** A bar with the right token but an unknown address is looked up over mDNS at most this often. */
const LOOKUP_EVERY_MS = 30_000;
/** How long the setup's "press Start" prompt waits. */
const SETUP_TEST_S = 120;
/** Changes whenever this file does, so --ensure replaces a daemon left running from an older version. */
const VERSION = codeVersion(fileURLToPath(import.meta.url));

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

if (flag("--print-hooks")) {
  console.log(JSON.stringify({ hooks: hooksBlock() }, null, 2));
  process.exit(0);
}
if (flag("--install-hooks")) {
  installHooks();
  process.exit(0);
}

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // First run: a token is made below and saved.
  }
  const result = {
    port: saved.port ?? 8790,
    token: typeof saved.token === "string" && saved.token.length >= 8 ? saved.token : randomBytes(9).toString("base64url"),
    bars: Array.isArray(saved.bars) ? saved.bars : ["10.0.4.20"],
    // The bar setup installed the app on: {id: "busybar-<usb mac>", name, serial}. Its mDNS id finds it on Wi-Fi.
    paired: saved.paired ?? null,
  };
  if (JSON.stringify(saved) !== JSON.stringify(result)) saveConfig(result);
  return result;
}

function saveConfig(value = config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function hooksBlock() {
  const hook = (event) => ({
    type: "http",
    url: `http://127.0.0.1:${PORT}/hook`,
    // Only a permission prompt waits for the bar; everything else is answered at once.
    timeout: event === "PermissionRequest" ? 600 : 5,
  });
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ matcher: "*", hooks: [hook(event)] }]]));
}

/** Adds our hooks next to whatever is in ~/.claude/settings.json already, keeping a dated backup. */
function installHooks() {
  const settings = existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  if (existsSync(SETTINGS_PATH)) {
    const backup = `${SETTINGS_PATH}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    copyFileSync(SETTINGS_PATH, backup);
    console.log(`backup: ${backup}`);
  }
  settings.hooks ??= {};
  const url = `http://127.0.0.1:${PORT}/hook`;
  for (const [event, groups] of Object.entries(hooksBlock())) {
    const existing = (settings.hooks[event] ??= []);
    const ours = existing.some((group) => group.hooks?.some((h) => h.type === "http" && h.url === url));
    if (!ours) existing.push(...groups);
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  console.log(`hooks for ${HOOK_EVENTS.length} events point at ${url} in ${SETTINGS_PATH}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/**
 * @typedef {"ready" | "working" | "input" | "done"} SessionState
 * ready: started, no task yet. working: on a task. input: asks the person something (a question, a plan).
 * done: finished the task and waits for the next one. A pending permission prompt is kept apart, in `prompts`.
 */

/** @type {Map<string, {id: string, cwd: string, transcript: string, state: SessionState, since: number, taskStart: number, took: number | null, doing: string, question: string | null, context: number | null, heard: number, transcriptMtime: number}>} */
const sessions = new Map();
/** Permission prompts waiting for an answer, oldest first. */
const prompts = [];
let nextPromptId = 1;

let version = 1;
let lastActivityBump = 0;
let activityTimer = null;
const waiters = new Set();

const nowS = () => Math.floor(Date.now() / 1000);

/** Something the bar should see changed. Activity-only changes are rate-limited; the rest go out at once. */
function changed(activityOnly = false) {
  if (activityOnly) {
    if (activityTimer) return;
    const wait = Math.max(0, lastActivityBump + ACTIVITY_EVERY_MS - Date.now());
    activityTimer = setTimeout(() => {
      activityTimer = null;
      bump();
    }, wait);
    return;
  }
  bump();
}

function bump() {
  version += 1;
  lastActivityBump = Date.now();
  for (const wake of waiters) wake();
  waiters.clear();
}

function session(input) {
  let s = sessions.get(input.session_id);
  if (!s) {
    s = {
      id: input.session_id,
      cwd: startCwd(input.transcript_path) ?? input.cwd ?? "",
      transcript: input.transcript_path ?? "",
      state: "ready",
      since: nowS(),
      taskStart: nowS(),
      took: null,
      doing: "",
      question: null,
      context: null,
      heard: Date.now(),
      transcriptMtime: 0,
    };
    sessions.set(s.id, s);
  }
  // The project stays the folder the session started in; `cwd` follows every `cd` the agent makes.
  if (!s.cwd && input.cwd) s.cwd = input.cwd;
  if (input.transcript_path) s.transcript = input.transcript_path;
  s.heard = Date.now();
  return s;
}

function setState(s, state, doing) {
  const stateChanged = s.state !== state;
  if (stateChanged) {
    s.state = state;
    s.since = nowS();
    // A finished task keeps its length; the bar shows it still, instead of a clock that keeps running.
    if (state === "done") s.took = s.since - s.taskStart;
  }
  const doingChanged = doing !== undefined && s.doing !== doing;
  if (doingChanged) s.doing = doing;
  if (stateChanged) changed();
  else if (doingChanged) changed(true);
}

/** Printable ASCII only: the bar's fonts have nothing else. */
function ascii(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim();
}

const base = (p) => (typeof p === "string" && p ? path.basename(p) : "");

/** "Edit client.ts", "Bash npm test": the tool and what it is aimed at, in a few words. */
function describeTool(name, input = {}) {
  const tool = String(name ?? "").startsWith("mcp__") ? String(name).split("__").pop() : String(name ?? "Tool");
  const target = (() => {
    switch (tool) {
      case "Bash":
        return input.command;
      case "Read":
      case "Edit":
      case "MultiEdit":
      case "Write":
        return base(input.file_path);
      case "NotebookEdit":
        return base(input.notebook_path);
      case "Grep":
      case "Glob":
        return input.pattern;
      case "WebFetch":
        try {
          return new URL(input.url).host;
        } catch {
          return input.url;
        }
      case "WebSearch":
        return input.query;
      case "Task":
      case "Agent":
        return input.description;
      default:
        return "";
    }
  })();
  return ascii(target ? `${tool} ${target}` : tool);
}

const project = (s) => ascii(base(s.cwd) || "claude");

/** Tools that wait for the person's words, not for a yes or no: the bar only says the session needs them. */
const ASKS_PERSON = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * The Claude desktop app ends a turn with this tool; with `ask` set, the turn ends on a question to the person,
 * answered with the app's buttons. No permission hook fires for it, so without this the session would look done.
 */
const DESKTOP_WRAP_UP = "mcp__ccd_turn__wrap_up";

/** What the person is asked, for the amber screen: the question itself where the tool says it. */
function question(name, input = {}) {
  if (name === "ExitPlanMode") return "Plan ready";
  const asked = name === "AskUserQuestion" ? input.questions?.[0]?.question : input.ask;
  return typeof asked === "string" && asked.trim() ? ascii(asked).slice(0, PROMPT_TEXT_MAX) : "Question";
}

/** Handles one hook event. Returns the hook's JSON answer, or a promise of it for a held permission prompt. */
function onHook(input) {
  const event = input.hook_event_name;
  if (!input.session_id || !event) return {};
  if (event === "SessionEnd") {
    sessions.delete(input.session_id);
    releasePrompts(input.session_id);
    changed();
    return {};
  }
  const s = session(input);

  switch (event) {
    case "SessionStart":
      if (s.state !== "working") setState(s, "ready", "");
      break;
    case "UserPromptSubmit":
      releasePrompts(s.id);
      s.question = null;
      // A new task: its timer starts now even when the session was already working.
      s.taskStart = nowS();
      s.took = null;
      setState(s, "working", "Thinking");
      changed();
      break;
    case "PreToolUse":
      // Reaching the next tool means any earlier prompt in this session was answered, here or in the terminal.
      releasePrompts(s.id);
      if (input.tool_name === DESKTOP_WRAP_UP && input.tool_input?.ask) s.question = question(input.tool_name, input.tool_input);
      if (ASKS_PERSON.has(input.tool_name)) setState(s, "input", question(input.tool_name, input.tool_input));
      else setState(s, "working", describeTool(input.tool_name, input.tool_input).slice(0, DOING_MAX));
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
      releasePrompts(s.id);
      setState(s, "working", "Thinking");
      break;
    case "Notification":
      // permission_prompt arrives ~6 s after PermissionRequest, which is already on the bar; idle_prompt repeats Stop.
      if (input.notification_type === "elicitation_dialog") setState(s, "input", "Question");
      break;
    case "Stop":
      releasePrompts(s.id);
      if (s.question) setState(s, "input", s.question);
      else setState(s, "done", "Done");
      readTranscript(s);
      break;
    case "StopFailure":
      releasePrompts(s.id);
      setState(s, "done", "Error");
      break;
    case "PermissionRequest":
      if (ASKS_PERSON.has(input.tool_name)) {
        setState(s, "input", question(input.tool_name, input.tool_input));
        return {};
      }
      return holdPrompt(s, input);
  }
  return {};
}

/**
 * Keeps a permission prompt open until it is answered; resolves to the hook's answer. The same request arriving
 * twice (hooks both in settings.json and in the plugin each fire) joins the prompt already open: one press answers both.
 */
function holdPrompt(s, input, { text, holdS = HOLD_S } = {}) {
  return new Promise((resolve) => {
    const key = `${s.id}\n${input.tool_name}\n${JSON.stringify(input.tool_input ?? null)}`;
    const same = text === undefined && prompts.find((p) => p.key === key);
    if (same) return same.resolvers.push(resolve);
    const prompt = {
      id: nextPromptId++,
      key,
      session: s.id,
      project: project(s),
      tool: describeTool(input.tool_name),
      text: ascii(text ?? `${project(s)}: ${describeTool(input.tool_name, input.tool_input)}`).slice(0, PROMPT_TEXT_MAX),
      resolvers: [resolve],
      timer: setTimeout(() => answerPrompt(prompt.id, "dismiss"), holdS * 1000),
    };
    prompts.push(prompt);
    log(`prompt ${prompt.id}: ${prompt.text}`);
    changed();
  });
}

const DECISIONS = {
  allow: { behavior: "allow" },
  deny: { behavior: "deny", message: "Denied from the BUSY Bar." },
};

/** Settles a prompt. "dismiss" gives no decision: Claude Code then asks in the terminal as usual. */
function answerPrompt(id, answer) {
  const i = prompts.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const [prompt] = prompts.splice(i, 1);
  clearTimeout(prompt.timer);
  const decision = DECISIONS[answer];
  for (const resolve of prompt.resolvers) resolve(decision ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } } : {});
  log(`prompt ${id}: ${answer}`);
  changed();
  return true;
}

/** Lets go of a session's prompts that were answered elsewhere: the session has moved on. */
function releasePrompts(sessionId) {
  for (const p of prompts.filter((p) => p.session === sessionId)) answerPrompt(p.id, "dismiss");
}

// ---------------------------------------------------------------------------------------------------------------
// Transcripts: context use, and interrupts (Esc fires no Stop hook)

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;

/** The folder a session started in: the first `cwd` its transcript recorded. Null for a new or unreadable one. */
function startCwd(file) {
  if (!file) return null;
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const length = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    for (const line of buffer.toString("utf8", 0, length).split("\n")) {
      try {
        const cwd = JSON.parse(line).cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch {
        // The last line may be cut off by the buffer.
      }
    }
  } catch {
    // No transcript yet: the hook's cwd is the starting folder then.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

function readTail(file) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8").split("\n").slice(size > length ? 1 : 0);
  } finally {
    closeSync(fd);
  }
}

function readTranscript(s) {
  if (!s.transcript) return;
  let mtime;
  try {
    mtime = statSync(s.transcript).mtimeMs;
  } catch {
    return;
  }
  if (mtime === s.transcriptMtime) return;
  s.transcriptMtime = mtime;

  let lines;
  try {
    lines = readTail(s.transcript);
  } catch {
    return;
  }
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line still being written.
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const usage = entries[i].message?.usage;
    if (entries[i].type === "assistant" && usage && !entries[i].isSidechain) {
      const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      // The transcript does not say which window the model had; past 200k it can only be the 1M one.
      const window = tokens > 200_000 ? 1_000_000 : 200_000;
      const context = Math.min(100, Math.round((tokens / window) * 100));
      if (context !== s.context) {
        s.context = context;
        changed(true);
      }
      break;
    }
  }

  const last = entries.findLast((e) => e.type === "user" || e.type === "assistant");
  const content = last?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join(" ") : "";
  if (s.state === "working" && last?.type === "user" && text.includes("[Request interrupted by user")) {
    releasePrompts(s.id);
    setState(s, "done", "Stopped");
  }
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.heard > FORGET_AFTER_MS) {
      sessions.delete(s.id);
      changed();
    } else if (s.state === "working") {
      readTranscript(s);
    }
  }
}, TRANSCRIPT_EVERY_MS).unref();

// ---------------------------------------------------------------------------------------------------------------
// Demo: made-up sessions for filming

function startDemo() {
  const fake = (id, cwd, state, ago, doing, context) => {
    sessions.set(id, { id, cwd, transcript: "", state, since: nowS() - ago, taskStart: nowS() - ago, took: state === "done" ? 17 * 60 + 8 : null, doing, question: null, context, heard: Infinity, transcriptMtime: 0 });
  };
  fake("demo-1", "/Users/demo/busy-app", "working", 31 * 60 + 41, "Edit client.ts", 62);
  fake("demo-2", "/Users/demo/website", "done", 4 * 60 + 12, "Done", 23);
  fake("demo-3", "/Users/demo/firmware", "working", 12 * 60 + 5, "Bash npm test", 41);
  const steps = ["Read api.ts", "Edit client.ts", "Bash npm test", "Thinking", "Grep useSession", "Edit hooks.ts"];
  let step = 0;
  setInterval(() => {
    const s = sessions.get("demo-1");
    if (!s) return;
    s.doing = steps[step++ % steps.length];
    changed(true);
  }, 2500).unref();
  // A prompt now and then; the bar's answer only clears it.
  const ask = () => {
    if (prompts.length === 0) {
      holdPrompt(sessions.get("demo-3"), { tool_name: "Bash", tool_input: { command: "git push origin main" } }).then(() => setTimeout(ask, 20000));
    }
  };
  setTimeout(ask, 5000);
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot for the bar

const STATE_ORDER = { input: 0, working: 1, done: 2, ready: 3 };

/** What the bar draws. Kept small: the bar parses it in a 128 KiB heap, every second. */
function snapshot() {
  const list = [...sessions.values()].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.since - b.since);
  const prompt = prompts[0];
  return {
    api: API_VERSION,
    v: version,
    now: nowS(),
    prompt: prompt ? { id: prompt.id, text: prompt.text, project: prompt.project, queue: prompts.length } : null,
    sessions: list.map((s) => ({
      // Short, but enough to keep the bar's cursor on the same session while the list reorders.
      id: s.id.slice(0, 8),
      name: project(s),
      state: s.state,
      // Working: since the task started, through any questions on the way. Otherwise: since the state began.
      since: s.state === "working" ? s.taskStart : s.since,
      // Seconds the last task took, for a session that is done.
      took: s.state === "done" ? s.took : null,
      doing: s.doing,
      context: s.context,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function log(message) {
  console.log(`${new Date().toLocaleTimeString()} ${message}`);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function tokenOk(req, url) {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("token") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

let lastLookup = 0;

/** Lets in a new address of the paired bar (its router gave it another one), once mDNS says it is that bar. */
async function learnBar(address) {
  if (Date.now() - lastLookup < LOOKUP_EVERY_MS) return false;
  lastLookup = Date.now();
  const bars = await findBars({ timeoutMs: 2000 }).catch(() => []);
  const bar = bars.find((b) => b.addresses.includes(address) && (!config.paired || b.id === config.paired.id));
  if (!bar) return false;
  BAR_ADDRESSES.add(address);
  config.bars = [...new Set([...config.bars, address])];
  saveConfig();
  log(`bar ${bar.id} is now at ${address}`);
  return true;
}

/** When the bar last asked for the state: setup tells "the bar can't reach this computer" from "nobody pressed". */
let barSeenAt = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const from = req.socket.remoteAddress ?? "";
  const local = LOOPBACK.has(from);
  try {
    if (url.pathname === "/hook" && req.method === "POST") {
      if (!local) return send(res, 403, { error: "hooks come from this Mac only" });
      const input = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, await onHook(input));
    }
    if (url.pathname === "/ping" && local) return send(res, 200, { version: VERSION, barSeenAt });
    if (url.pathname === "/quit" && req.method === "POST" && local) {
      send(res, 200, { ok: true });
      for (const p of [...prompts]) answerPrompt(p.id, "dismiss");
      server.close();
      setTimeout(() => process.exit(0), 100).unref();
      return;
    }
    if (url.pathname === "/setup-test" && req.method === "POST" && local) {
      const started = Date.now();
      const answer = await holdPrompt({ id: "setup", cwd: "Setup" }, {}, { text: "Setup: press Start on the bar", holdS: SETUP_TEST_S });
      const behavior = answer.hookSpecificOutput?.decision?.behavior ?? "dismiss";
      return send(res, 200, { answer: behavior, barSeen: barSeenAt >= started });
    }

    const address = from.replace(/^::ffff:/, "");
    const tokenGood = tokenOk(req, url);
    const bar = BAR_ADDRESSES.has(address) || local || (tokenGood && (await learnBar(address)));
    if (!bar || !tokenGood) {
      log(`refused ${req.method} ${url.pathname} from ${from}`);
      // 401 tells the bar its token is wrong; 403 that it calls from an address that isn't a known bar.
      return send(res, bar ? 401 : 403, { error: bar ? "wrong token" : "forbidden" });
    }

    if (url.pathname === "/state" && req.method === "GET") {
      barSeenAt = Date.now();
      const seen = Number(url.searchParams.get("v") ?? 0);
      if (seen === version) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(resolve);
            resolve();
          }, POLL_WAIT_MS);
          waiters.add(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return send(res, 200, snapshot());
    }

    if (url.pathname === "/answer" && req.method === "POST") {
      const { id, answer } = JSON.parse((await readBody(req)) || "{}");
      if (!["allow", "deny", "dismiss"].includes(answer)) return send(res, 400, { error: "answer is allow, deny or dismiss" });
      return send(res, 200, { ok: answerPrompt(Number(id), answer) });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    log(`${req.method} ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) send(res, 400, { error: "bad request" });
  }
});

// A held prompt can stay open for minutes; Node's default request timeout would cut it at 5 minutes.
server.requestTimeout = 0;
server.headersTimeout = 10_000;

const paths = { configDir: CONFIG_DIR, settings: SETTINGS_PATH };

if (flag("--ensure")) {
  // Run by a SessionStart hook: whatever it prints would land in Claude's context, so it prints nothing.
  await ensure({ port: PORT, version: VERSION, configDir: CONFIG_DIR }).catch(() => {});
  process.exit(0);
} else if (args[0] === "setup") {
  process.exit(await setup({ port: PORT, version: VERSION, config, saveConfig, paths }));
} else if (args[0] === "uninstall") {
  process.exit(await uninstall({ port: PORT, config, paths, hookUrl: `http://127.0.0.1:${PORT}/hook` }));
} else {
  server.on("error", (err) => {
    // Two sessions starting at once both run --ensure; the second daemon finds the port taken and leaves.
    console.error(err.code === "EADDRINUSE" ? `port ${PORT} is taken: the daemon is already running` : err.message);
    process.exit(1);
  });
  server.listen(PORT, "0.0.0.0", () => {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => `${a.address}:${PORT}`);
    console.log(`Claude Code bar daemon on ${addresses.join(", ")}`);
    console.log(`bar app settings: Computer = one of the addresses above, Token = ${config.token}`);
    console.log(`bars allowed from: ${[...BAR_ADDRESSES].join(", ")} (config: ${CONFIG_PATH})`);
    if (flag("--demo")) {
      startDemo();
      console.log("demo mode: made-up sessions");
    }
  });
}
