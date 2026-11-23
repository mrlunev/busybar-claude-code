import { BASE, device } from "@shared/device";
import { helpElements, type WebAddress, webAddresses } from "./help.ts";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const DEFAULT_HOST = "10.0.4.21:8790";
/** The daemon's port when none is given; left out of the address on screen. */
const DEFAULT_PORT = "8790";
/** The newest daemon protocol this app understands; the daemon sends its own as `api` (none means 1). */
const API = 1;

/** Waits after a round in which no address answered, so an unreachable computer is not hammered. */
const RETRY_MS = [1000, 2000, 5000];
/** The pause before trying the next address of the same round. */
const NEXT_HOST_MS = 200;
/** How often a daemon newer than the app is asked again. */
const TOO_NEW_RETRY_MS = 30000;
/** Failures in a row before the screen says the computer is gone; shorter hiccups keep the last picture. */
const STALE_AFTER = 3;
/** How often the bar's own addresses are looked up again while the back screen shows where to open its web page. */
const HELP_MS = 10000;
/** A prompt takes no answer until it has been on the screen this long: a press meant for the screen before must not answer it. */
const ANSWER_AFTER_MS = 400;
/** The daemon's clock comes in whole seconds; a smaller change of the offset is that rounding, not a new clock. */
const OFFSET_SLACK = 2;

/** Text starts right of the mascot, as in the mockup; the glyphs land on rows 2-7 and 9-13. */
const TEXT_X = 18;
const TEXT_WIDTH = 52;
const LINE_1_Y = 0;
const LINE_2_Y = 7;
/** The timer's digits are 4 px apart and its colons 2: "12:34" is 17 px wide, "01:23:45" 27. */
const TIMER_WIDTH = { short: 17, hours: 27 };
/** The project name follows the timer after this gap; small-font letters take about 4 px each. */
const NAME_GAP = 3;
const NAME_CHAR_WIDTH = 4;
const TEXT_RIGHT = 70;

/** The session list: two rows of 8 px, an 8x8 mascot, the name, the timer on the right before the scroll bar. */
const LIST_ROWS = 2;
const LIST_ROW_HEIGHT = 8;
const LIST_NAME_X = 11;
const LIST_TEXT_RIGHT = 69;
const CURSOR = "#2E313DFF";
/**
 * Screens are rebuilt this often even without news: the name moves when a timer passes an hour, and the LED
 * blink is repeated. Only changed elements are sent, so a quiet tick costs no draw.
 */
const TICK_MS = 1000;
/** The firmware's notification blink lasts 3 s (three blinks); while a prompt waits it is started again. */
const LED_REPEAT_MS = 3000;
const LED_COLOR = "#FFB000FF";
/** The bottom edge of the frame between its rounded corners. */
const CONTEXT_WIDTH = 68;

const WHITE = "#FFFFFFFF";
const GREY = "#A3A7B4FF";
const DIM = "#6C6F7CFF";

/** The bar's colours per session state: the frame, the mascot, and the tint of the bottom line. */
type Look = "working" | "approve" | "done" | "idle";

/** Bottom line per frame: the timer, and the dimmer project name. On green and amber they take the frame's tint. */
const TINT: Record<Look, { timer: string; name: string }> = {
  working: { timer: GREY, name: DIM },
  approve: { timer: "#C49A4AFF", name: "#8C6A2CFF" },
  done: { timer: "#5FA36AFF", name: "#3F7449FF" },
  idle: { timer: GREY, name: DIM },
};

/**
 * The mascot per frame. Working, it thinks (looks around, blinks, thought dots); waiting for you, it calls (jumps,
 * waves, stomps). Both are .anim files the firmware plays by itself, on a 16x14 canvas around the mascot.
 * The firmware cannot turn an element into another type, so the animation and the picture have their own ids.
 */
const MASCOT: Record<Look, Element> = {
  working: { id: "mascot_anim", type: "animation", path: "animations/thinking.anim", loop: true, x: 1, y: 1, z_index: 1 },
  approve: { id: "mascot_anim", type: "animation", path: "animations/calling.anim", loop: true, x: 1, y: 1, z_index: 1 },
  done: { id: "mascot", type: "image", path: "images/icon_done.png", x: 2, y: 3, z_index: 1 },
  idle: { id: "mascot", type: "image", path: "images/icon_idle.png", x: 2, y: 3, z_index: 1 },
};

type SessionState = "ready" | "working" | "input" | "done";

type Session = {
  /** Stable while the session lives; the list keeps its cursor on it while the order changes. */
  id: string;
  name: string;
  state: SessionState;
  /** Unix seconds, the computer's clock: when the task started, or since when the session waits. */
  since: number;
  doing: string;
  /** Context window use, percent; null until known. */
  context: number | null;
  /** Seconds the last task took; set while the session is done. */
  took: number | null;
};

type Prompt = { id: number; text: string; queue: number };

type Model = { v: number; now: number; prompt: Prompt | null; sessions: Session[]; api?: number };

const LOOK: Record<SessionState, Look> = { working: "working", input: "approve", done: "done", ready: "done" };

/** Marquee for text wider than its box: pixels per minute and pauses. */
const SCROLL = { scroll_rate: 1500, scroll_start_delay: 1500, scroll_repeat_delay: 2000 };

type Element = Record<string, unknown> & { id: string };

function text(id: string, value: string, x: number, y: number, color: string, extra: Record<string, unknown> = {}): Element {
  return { id, type: "text", text: value, font: "small", color, x, y, align: "top_left", z_index: 2, ...extra };
}

function image(id: string, path: string, x: number, y: number): Element {
  return { id, type: "image", path, x, y };
}

function frame(look: Look): Element[] {
  return [{ ...image("bg", `images/bg_${look}.png`, 0, 0), z_index: 0 }, MASCOT[look]];
}

/** Counts up from `since` on the bar itself, so a running timer needs no redraws. `offset` maps the computer's time to bar time. */
function timer(since: number, offset: number, color: string): Element {
  return {
    id: "timer",
    type: "countdown",
    timestamp: String(Math.round(since - offset)),
    direction: "time_since",
    show_hours: "when_non_zero",
    color,
    x: TEXT_X,
    y: LINE_2_Y,
    align: "top_left",
    z_index: 2,
  };
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** "07:29", or "01:02:03" past an hour: the way the firmware's countdown writes it. */
function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const mm = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return h > 0 ? `${pad(h)}:${mm}` : mm;
}

/**
 * The time shown for a session: a running clock while it works or waits for an answer, how long the task took
 * once it is done (still, not counting on), nothing before its first task. The two kinds of element get their
 * own ids: the firmware cannot turn one element type into another.
 */
function clock(id: string, s: Session, offset: number, color: string, place: Record<string, unknown>): { element: Element | null; seconds: number } {
  if (s.state === "ready") return { element: null, seconds: 0 };
  if (s.state === "done") {
    if (s.took === null) return { element: null, seconds: 0 };
    return { element: { ...text(`${id}_took`, duration(s.took), TEXT_X, LINE_2_Y, color), ...place }, seconds: s.took };
  }
  return { element: { ...timer(s.since, offset, color), id, ...place }, seconds: Date.now() / 1000 + offset - s.since };
}

/** The clock grows by an hours field after the first hour. */
const clockWidth = (seconds: number) => (seconds >= 3600 ? TIMER_WIDTH.hours : TIMER_WIDTH.short);

const STATE_LINE: Record<SessionState, (s: Session) => string> = {
  working: (s) => s.doing || "Working",
  input: (s) => s.doing || "Needs you",
  done: (s) => s.doing || "Done",
  ready: () => "Ready",
};

function sessionScreen(s: Session, offset: number, contextBar: boolean): Element[] {
  const look = LOOK[s.state];
  // The name sits right after the time.
  const time = clock("timer", s, offset, TINT[look].timer, {});
  const nameX = time.element === null ? TEXT_X : TEXT_X + clockWidth(time.seconds) + NAME_GAP;
  const elements = [
    ...frame(look),
    text("line1", STATE_LINE[s.state](s), TEXT_X, LINE_1_Y, WHITE, { width: TEXT_WIDTH, ...SCROLL }),
    text("name", s.name.slice(0, Math.floor((TEXT_RIGHT - nameX) / NAME_CHAR_WIDTH)), nameX, LINE_2_Y, TINT[look].name),
  ];
  if (time.element) elements.push(time.element);
  // The frame's bottom edge doubles as the context meter: its filled part is drawn white over the border.
  const filled = contextBar && s.context !== null ? Math.round((CONTEXT_WIDTH * s.context) / 100) : 0;
  if (filled > 0) {
    elements.push({ id: "context", type: "rectangle", x: 2, y: 15, width: filled, height: 1, fill: "solid", fill_colors: [WHITE], border_width: 0, z_index: 1 });
  }
  return elements;
}

/**
 * The session list: two 8 px rows, each a small mascot coloured by the state, the project name, and the task
 * time on the right. The cursor row is highlighted and its name scrolls when it is too long; a thin bar on the
 * right edge shows where the two rows are in a longer list.
 */
function listScreen(sessions: Session[], cursor: number, top: number, offset: number): Element[] {
  const elements: Element[] = [];
  for (let row = 0; row < LIST_ROWS; row++) {
    const s = sessions[top + row];
    if (!s) break;
    const y = row * LIST_ROW_HEIGHT;
    const look = LOOK[s.state];
    const selected = top + row === cursor;
    if (selected) {
      elements.push({ id: "cursor", type: "rectangle", x: 0, y, width: LIST_TEXT_RIGHT + 1, height: LIST_ROW_HEIGHT, radius: 1, fill: "solid", fill_colors: [CURSOR], border_width: 0, z_index: 0 });
    }
    elements.push({ ...image(`row${row}_icon`, `images/list_${look}.png`, 1, y), z_index: 1 });
    // The name ends before this row's time.
    const time = clock(`row${row}_timer`, s, offset, TINT[look].timer, { x: LIST_TEXT_RIGHT, y, align: "top_right" });
    const width = LIST_TEXT_RIGHT - LIST_NAME_X - (time.element === null ? 0 : clockWidth(time.seconds) + NAME_GAP);
    const name = selected ? { width, ...SCROLL } : {};
    const shown = selected ? s.name : s.name.slice(0, Math.floor(width / NAME_CHAR_WIDTH));
    elements.push(text(`row${row}_name`, shown, LIST_NAME_X, y, selected ? WHITE : GREY, name));
    if (time.element) elements.push(time.element);
  }
  if (sessions.length > LIST_ROWS) {
    const thumb = Math.max(2, Math.round((16 * LIST_ROWS) / sessions.length));
    const y = Math.round(((16 - thumb) * top) / (sessions.length - LIST_ROWS));
    elements.push({ id: "scrollbar", type: "rectangle", x: 71, y, width: 1, height: thumb, fill: "solid", fill_colors: [DIM], border_width: 0, z_index: 1 });
  }
  return elements;
}

/** Yes and No: the picked one is dark on a bright amber plate, the other light amber on the frame. */
const CHOICE = { plate: "#FFCD6AFF", picked: "#3A2608FF", other: "#F0D9A8FF" };

/**
 * The approval screen: the frame's outline is a ring of dashes running clockwise, so it reads from across a room.
 * Without `choice`, the frame stays up with no Yes and No while the next prompt of the queue is on its way.
 */
function promptScreen(p: Prompt, choice: "yes" | "no" | null): Element[] {
  const plate = (x: number, width: number): Element => ({
    id: "plate",
    type: "rectangle",
    x,
    y: 8,
    width,
    height: 7,
    radius: 1,
    fill: "solid",
    fill_colors: [CHOICE.plate],
    border_width: 0,
    z_index: 1,
  });
  const elements: Element[] = [
    ...frame("approve"),
    { id: "border_anim", type: "animation", path: "animations/border.anim", loop: true, x: 0, y: 0, z_index: 1 },
    text("line1", choice === null ? "Next request" : `Approve? ${p.text}`, TEXT_X, LINE_1_Y, WHITE, { width: TEXT_WIDTH, ...SCROLL }),
  ];
  if (choice !== null) {
    elements.push(
      choice === "yes" ? plate(17, 15) : plate(34, 12),
      text("yes", "Yes", 19, LINE_2_Y, choice === "yes" ? CHOICE.picked : CHOICE.other),
      text("no", "No", 36, LINE_2_Y, choice === "no" ? CHOICE.picked : CHOICE.other),
    );
  }
  if (p.queue > 1) elements.push(text("queue", `+${p.queue - 1}`, TEXT_RIGHT, LINE_2_Y, TINT.approve.timer, { align: "top_right" }));
  return elements;
}

function messageScreen(line1: string, line2: string): Element[] {
  return [...frame("idle"), text("line1", line1, TEXT_X, LINE_1_Y, GREY), text("line2", line2, TEXT_X, LINE_2_Y, DIM, { width: TEXT_WIDTH, ...SCROLL })];
}

/**
 * Nothing set up on the computer yet (installed from the catalog): the mascot lies dead, the front says to look at
 * the back, and the back says where to open the bar's web page; the app's settings there hold the guide.
 */
function setupScreen(back: Element[]): Element[] {
  return [
    { ...image("bg", "images/bg_idle.png", 0, 0), z_index: 0 },
    { id: "mascot", type: "image", path: "images/icon_dead.png", x: 2, y: 3, z_index: 1 },
    text("line1", "Needs setup", TEXT_X, LINE_1_Y, GREY, { width: TEXT_WIDTH, ...SCROLL }),
    text("line2", "look at the back", TEXT_X, LINE_2_Y, DIM, { width: TEXT_WIDTH, ...SCROLL }),
    ...back,
  ];
}

// ---------------------------------------------------------------------------------------------------------------

/** What is on the screen now, by element id, to send only what changed. */
const onScreen = new Map<string, string>();

async function send(elements: Element[], ledColor: string | null): Promise<void> {
  await device.DisplayDraw({ application_name: APP, priority: 50, elements, ...(ledColor ? { led_notification_color: ledColor } : {}) });
}

/**
 * Sends only what changed. The firmware refuses a whole delete when one of the ids is already gone, so on any
 * refusal everything of ours is cleared and drawn again.
 * Elements are compared by their JSON, kept from the last draw: on the bar every JerryScript instruction costs
 * about 3 microseconds, so each element is stringified once per draw for the comparison.
 */
async function draw(elements: Element[], ledColor: string | null): Promise<void> {
  const json = elements.map((e) => JSON.stringify(e));
  const changed = elements.filter((e, i) => onScreen.get(e.id) !== json[i]);
  const present = new Set(elements.map((e) => e.id));
  const removed = [...onScreen.keys()].filter((id) => !present.has(id));
  try {
    if (removed.length > 0) await device.DisplayClear({ application_name: APP, element_ids: removed });
    // A blink with nothing new to draw rides on the background, sent again unchanged.
    if (ledColor && changed.length === 0) changed.push(...elements.filter((e) => e.id === "bg"));
    if (changed.length > 0) await send(changed, ledColor);
  } catch (err) {
    console.error(`${APP}: redrawing the whole screen: ${err instanceof Error ? err.message : String(err)}`);
    onScreen.clear();
    await device.DisplayClear({ application_name: APP });
    await send(elements, ledColor);
  }
  onScreen.clear();
  elements.forEach((e, i) => onScreen.set(e.id, json[i]!));
}

/** `bases`: the computer's addresses in the order they are tried, e.g. its Wi-Fi address, then its USB one. */
type Settings = { bases: string[]; token: string; contextBar: boolean };

/** "192.168.1.20:8790,10.0.4.21:8790" → ["http://192.168.1.20:8790", "http://10.0.4.21:8790"]. */
function parseHosts(host: string): string[] {
  const bases = host
    .split(",")
    .map((h) => h.trim().replace(/\/+$/, ""))
    .filter((h) => h !== "")
    .map((h) => (h.includes("://") ? h : `http://${h}`));
  return bases.length > 0 ? bases : [`http://${DEFAULT_HOST}`];
}

/** The address as the screen shows it: no scheme, no default port. */
function shortHost(base: string): string {
  return base.replace(/^[a-z]+:\/\//, "").replace(new RegExp(`:${DEFAULT_PORT}$`), "");
}

async function loadSettings(): Promise<Settings> {
  let host = DEFAULT_HOST;
  let token = "";
  let contextBar = false;
  try {
    const { values } = await device.AppsSettingsGet({ app_id: APP });
    if (typeof values.host === "string" && values.host.trim() !== "") host = values.host.trim();
    if (typeof values.token === "string") token = values.token.trim();
    if (typeof values.context_bar === "boolean") contextBar = values.context_bar;
  } catch (err) {
    console.error(`${APP}: settings unavailable, using ${DEFAULT_HOST}: ${String(err)}`);
  }
  return { bases: parseHosts(host), token, contextBar };
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  let settings: Settings = { bases: [], token: "", contextBar: false };
  /** The address in use: the one that last answered, or the one being tried. */
  let active = 0;
  /** Attempts since the last answer; every address gets one per round. */
  let attempts = 0;
  /**
   * A daemon turned the bar away: 401, the token is wrong; 403, the daemon does not know this bar's address (the
   * computer was never set up with this bar). Cleared by the next answer.
   */
  let refused: "token" | "bar" | null = null;
  /** The daemon speaks a newer protocol than this app. */
  let tooNew = false;
  let model: Model | null = null;
  /** The computer's clock minus the bar's clock, seconds. */
  let offset = 0;
  /** The last error per address, so each is logged once while it lasts. */
  const errors = new Map<string, string>();

  /**
   * Two levels: the list of sessions, and one session in full. The wheel moves the list's cursor, Start opens the
   * session under it, Back goes up a level and, from the list, leaves the app. Sessions are kept by id, because the
   * computer reorders them as their states change.
   */
  let level: "list" | "session" = "list";
  let cursorId = "";
  /** The list's first visible row. */
  let top = 0;
  let stopped = false;
  let choice: "yes" | "no" = "yes";
  /** Prompts answered or waved off here; hidden at once, before the computer confirms. */
  const handled = new Set<number>();
  /** The prompt on the screen, from the draw that showed it, and since when; presses answer only this one. */
  let shown: { id: number; at: number } | null = null;
  /** When the LED last started blinking, and for which prompt. */
  let blinkedAt = 0;
  let blinkedFor: number | null = null;
  /** Pending waits of the poll loop; quit() cuts them short. */
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();

  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);
  const base = () => settings.bases[active] ?? `http://${DEFAULT_HOST}`;
  const headers = () => ({ Authorization: `Bearer ${settings.token}` });

  const activePrompt = (): Prompt | null => (model?.prompt && !handled.has(model.prompt.id) ? model.prompt : null);
  /** Answered here with more in the queue: the daemon is about to send the next one. */
  const nextComing = (p: Prompt) => handled.has(p.id) && p.queue > 1;
  /** A press answers a prompt only once it is on the screen and has been there long enough to be read. */
  const answerable = (p: Prompt) => shown !== null && shown.id === p.id && Date.now() - shown.at >= ANSWER_AFTER_MS;

  function later(ms: number, done: () => void): void {
    if (stopped) return done();
    const handle = setTimeout(() => {
      timers.delete(handle);
      done();
    }, ms);
    timers.set(handle, done);
  }

  function screen(): { elements: Element[]; led: string | null; prompt?: Prompt } {
    if (settings.token === "") return { elements: setupScreen(help.elements), led: null };
    if (tooNew) return { elements: messageScreen("Update app", "run setup"), led: null };
    if (model === null) {
      if (refused === "token") return { elements: messageScreen("Wrong token", "run setup again"), led: null };
      if (refused === "bar") return { elements: messageScreen("Not paired", "run setup"), led: null };
      const stale = attempts >= Math.max(STALE_AFTER, settings.bases.length);
      return { elements: messageScreen(stale ? "No computer" : "Connecting", shortHost(base())), led: null };
    }
    const prompt = activePrompt();
    if (prompt) {
      // A new prompt blinks at once; one that keeps waiting blinks again once the last blink is over.
      const now = Date.now();
      const led = prompt.id !== blinkedFor || now - blinkedAt >= LED_REPEAT_MS ? LED_COLOR : null;
      if (led) {
        blinkedAt = now;
        blinkedFor = prompt.id;
      }
      return { elements: promptScreen(prompt, choice), led, prompt };
    }
    if (model.prompt && nextComing(model.prompt)) return { elements: promptScreen(model.prompt, null), led: null };
    const { sessions } = model;
    if (sessions.length === 0) return { elements: messageScreen("Connected", "no sessions yet"), led: null };
    const cursor = cursorIndex();
    // A session that ended while open drops back to the list.
    if (level === "session" && sessions[cursor]?.id === cursorId) {
      return { elements: sessionScreen(sessions[cursor]!, offset, settings.contextBar), led: null };
    }
    level = "list";
    top = Math.min(Math.max(top, cursor - LIST_ROWS + 1), cursor, Math.max(0, sessions.length - LIST_ROWS));
    return { elements: listScreen(sessions, cursor, top, offset), led: null };
  }

  /** Where the cursor is; a session that left takes the cursor to the top. */
  function cursorIndex(): number {
    const sessions = model?.sessions ?? [];
    const i = sessions.findIndex((s) => s.id === cursorId);
    if (i >= 0) return i;
    cursorId = sessions[0]?.id ?? "";
    return 0;
  }

  /** Leaves the app: nothing keeps it alive once the timers are cleared, the poll loop ends and the input handler is gone. */
  function quit(): void {
    stopped = true;
    clearInterval(recheck);
    // A sleep cut short lets the poll loop see `stopped` now; a long poll already sent still runs to its end.
    for (const [handle, done] of timers) {
      clearTimeout(handle);
      done();
    }
    timers.clear();
    // Not detached from inside the handler itself: with nothing else left the unbind stops the app on the spot.
    setTimeout(unbind, 0);
  }

  // Draws go one after another; a request made while one is running is folded into the next.
  let drawing = false;
  let dirty = false;
  async function render(): Promise<void> {
    dirty = true;
    if (drawing) return;
    drawing = true;
    while (dirty) {
      dirty = false;
      if (stopped) break;
      const { elements, led, prompt } = screen();
      try {
        await draw(elements, led);
        if (!prompt) shown = null;
        else if (shown?.id !== prompt.id) shown = { id: prompt.id, at: Date.now() };
      } catch (err) {
        // What the screen shows is unknown now.
        shown = null;
        report(err);
      }
    }
    drawing = false;
  }

  /**
   * Long-polls the daemon. The addresses are tried in order; the first that answers is kept, and on a failure the
   * next one is tried. A refusal counts as a failure too: the daemon may know the bar by its other address.
   */
  async function poll(): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((resolve) => later(ms, resolve));
    while (!stopped) {
      try {
        const response = await fetch(`${base()}/state?v=${model?.v ?? 0}`, { headers: headers() });
        if (!response.ok) {
          // Read the body either way so the firmware can free the connection.
          await response.text().catch(() => "");
          if (response.status === 401 || response.status === 403) {
            const kind = response.status === 401 ? "token" : "bar";
            if (refused !== kind) {
              refused = kind;
              void render();
            }
            throw new Error(`${shortHost(base())}: ${kind === "token" ? "wrong token" : "this bar is not paired"}`);
          }
          throw new Error(`${shortHost(base())}: daemon answered ${response.status}`);
        }
        const next = (await response.json()) as Model;
        refused = null;
        attempts = 0;
        if (typeof next.api === "number" && next.api > API) {
          if (!tooNew) report(`daemon api ${next.api}, app understands ${API}: update the app`);
          tooNew = true;
          model = null;
          void render();
          await sleep(TOO_NEW_RETRY_MS);
          continue;
        }
        tooNew = false;
        // `now` is whole seconds: a smaller change is the rounding, and following it would step the timers.
        const measured = next.now - Date.now() / 1000;
        if (model === null || Math.abs(measured - offset) > OFFSET_SLACK) offset = measured;
        // A new prompt starts on Yes; a prompt that left the queue no longer needs hiding.
        if (next.prompt?.id !== model?.prompt?.id) choice = "yes";
        for (const id of handled) if (next.prompt?.id !== id) handled.delete(id);
        model = next;
        errors.clear();
        void render();
      } catch (err) {
        attempts += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (errors.get(base()) !== message) report(err);
        errors.set(base(), message);
        const hosts = settings.bases.length;
        active = (active + 1) % hosts;
        const stale = attempts >= Math.max(STALE_AFTER, hosts);
        if (stale && model !== null) model = null;
        // The screen names the address being tried, so it is redrawn on every move while nothing is shown.
        if (model === null) void render();
        // Every address of the round is tried before waiting longer.
        const round = Math.ceil(attempts / hosts);
        await sleep(attempts % hosts !== 0 ? NEXT_HOST_MS : RETRY_MS[Math.min(round, RETRY_MS.length) - 1]!);
      }
    }
  }

  function answer(prompt: Prompt, value: "allow" | "deny" | "dismiss"): void {
    handled.add(prompt.id);
    void render();
    fetch(`${base()}/answer`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ id: prompt.id, answer: value }) })
      .then(async (response) => {
        await response.text().catch(() => "");
        // Gone: the computer no longer holds it (answered in the terminal, or handed back there); it stays hidden.
        if (response.status === 410) return console.log(`${APP}: prompt ${prompt.id} is no longer waiting, the terminal has it`);
        if (!response.ok) throw new Error(`answer refused: ${response.status}`);
      })
      .catch((err: unknown) => {
        // Not delivered: show the prompt again, the computer is still waiting for it.
        handled.delete(prompt.id);
        report(err);
        void render();
      });
  }

  // The listener keeps the app alive; a long Back is handled by the firmware and quits it.
  const unbind = listen("input", (event) => {
    if (stopped) return;
    const press = event.action === "short";
    const enter = press && (event.key === "start" || event.key === "ok");
    const back = press && event.key === "back";
    const prompt = activePrompt();
    const sessions = model?.sessions ?? [];
    let changed = true;
    if (model?.prompt && (prompt || nextComing(model.prompt))) {
      // While a prompt waits, presses go to it alone, and only once it can be answered.
      if (!prompt || !answerable(prompt)) changed = false;
      // Yes is on the left, No on the right; the wheel's +1 moves the list down and here moves right.
      else if (event.key === "encoder") choice = event.delta < 0 ? "yes" : "no";
      else if (enter) answer(prompt, choice === "yes" ? "allow" : "deny");
      else if (back) answer(prompt, "dismiss");
      else changed = false;
    } else if (level === "session") {
      if (back) level = "list";
      else changed = false;
    } else if (event.key === "encoder" && sessions.length > 0) {
      const next = Math.min(sessions.length - 1, Math.max(0, cursorIndex() + event.delta));
      cursorId = sessions[next]!.id;
    } else if (enter && sessions.length > 0) {
      cursorIndex();
      level = "session";
    } else if (back) {
      quit();
      return;
    } else {
      changed = false;
    }
    if (changed) void render();
  });

  /** The back screen's guide while nothing is set up; built again only when the bar's addresses change. */
  const help: { key: string; at: number; elements: Element[] } = { key: "", at: 0, elements: [] };
  /** Looks up where the bar's web page opens: a cable may come, Wi-Fi may join. */
  async function refreshHelp(): Promise<void> {
    if (settings.token !== "" || Date.now() - help.at < HELP_MS) return;
    help.at = Date.now();
    const addresses: WebAddress[] = await webAddresses(BASE);
    const key = JSON.stringify(addresses);
    if (key === help.key) return;
    help.key = key;
    help.elements = helpElements(addresses);
    void render();
  }

  const recheck = setInterval(() => {
    void render();
    refreshHelp().catch(report);
  }, TICK_MS);

  void (async () => {
    settings = await loadSettings();
    await refreshHelp();
    await render();
    if (settings.token !== "") await poll();
  })().catch(report);
}

main();
