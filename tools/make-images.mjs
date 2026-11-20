// Generates the app's images: the framed backgrounds for each session state, the Claude Code mascot, its two
// animations, and the APPS menu icons. Colours follow the Figma mockups.
// Run after changing a colour or shape: npm run images (this script writes PNGs and animation frames, then
// tools/pack.py turns the frames into .anim files).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

/** The mascot's colours, top to bottom of its body: the same while it works and while it calls for you. */
const ORANGE = ["#F99C7C", "#CE5128"];

/**
 * Per state: frame border, background gradient top and bottom, and how much darker than the mockup each is
 * drawn. The mascot is orange on every frame but the green one.
 */
const STATES = {
  working: { border: "#868691", fill: ["#474A5B", "#1E2027"], dim: { border: 0.25, fill: 0.15 } },
  approve: { border: "#FFCD6A", fill: ["#7A5622", "#4B4121"], dim: { border: 0.4, fill: 0.3 } },
  done: { border: "#7FD18B", fill: ["#2C5233", "#1A2A1E"], dim: { border: 0.25, fill: 0.15 }, icon: ["#B4F0A8", "#3E9F4C"] },
  idle: { border: "#55565E", fill: ["#2A2B33", "#15161A"], dim: { border: 0, fill: 0 }, icon: ["#A3A7B4", "#5A5C66"] },
};

/**
 * The session list has a small mascot per row on a plain background, so there the colour is the only sign of the
 * state.
 */
const LIST_ICONS = { working: ORANGE, approve: ["#F9D07C", "#CE8A28"], done: STATES.done.icon, idle: STATES.idle.icon };

/** The mascot at 8x8, for the list: body, eyes, arms, two legs. */
const SMALL = [
  ".######.",
  ".#.##.#.",
  ".#.##.#.",
  "########",
  ".######.",
  ".######.",
  "..#..#..",
  "..#..#..",
];

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => rgb(a).map((v, i) => Math.round(v + (rgb(b)[i] - v) * t));
const darker = (color, amount) => color.map((v) => Math.round(v * (1 - amount)));

/** Encodes 8-bit pixels: `channels` 1 is greyscale, 4 is RGBA. */
function png(width, height, channels, pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Colour type by channels: 1 greyscale, 2 greyscale + alpha, 4 RGBA.
  header.set([8, { 1: 0, 2: 4, 4: 6 }[channels], 0, 0, 0], 8);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function save(path, data) {
  writeFileSync(new URL(`../src/${path}`, import.meta.url), data);
  console.log(`src/${path}`);
}

/**
 * The whole 72x16 screen: a 1px border with the corners cut as in the mockup (one pixel off each corner, the
 * next two at half strength), over a vertical gradient. The sides fade out towards the bottom, so the bottom edge,
 * which doubles as the context meter, stands on its own. Opaque, so it also clears whatever was drawn before.
 */
function background({ border, fill, dim }) {
  const width = 72;
  const height = 16;
  const edgeColor = darker(rgb(border), dim.border);
  const [top, bottom] = fill.map((c) => darker(rgb(c), dim.fill));
  const pixels = Buffer.alloc(width * height * 4);
  const corner = (x, y) => Math.min(x, width - 1 - x) + Math.min(y, height - 1 - y);
  for (let y = 0; y < height; y++) {
    const t = Math.min(1, Math.max(0, (y - 1) / (height - 3)));
    const inside = top.map((v, i) => Math.round(v + (bottom[i] - v) * t));
    // Full strength at the top, gone by the bottom row.
    const side = darker(edgeColor, y / (height - 1));
    for (let x = 0; x < width; x++) {
      const isSide = x === 0 || x === width - 1;
      const edge = isSide || y === 0 || y === height - 1;
      const c = corner(x, y);
      let color = !edge ? inside : isSide ? side : edgeColor;
      if (c === 0) color = [0, 0, 0];
      else if (c === 1 && edge) color = color.map((v) => Math.round(v * 0.45));
      pixels.set([...color, 255], (y * width + x) * 4);
    }
  }
  return png(width, height, 4, pixels);
}

// ---------------------------------------------------------------------------------------------------------------
// The mascot, built from parts so it can move.
//
// It is 14x11, as in the mockup: a 10x9 body (columns 2-11, rows 0-8) with two 2x3 eye holes (columns 4-5 and
// 8-9, rows 2-4), 2x2 arms on both sides (rows 4-5), and four 1x2 legs (columns 3, 5, 8, 10, rows 9-10).

/**
 * @typedef {object} Pose
 * @property {number} [dy] whole body up (negative) or down, pixels
 * @property {"open" | "closed" | "left" | "right" | "up"} [eyes]
 * @property {[number, number]} [arms] how high each arm is raised, pixels (left, right)
 * @property {[number, number, number, number]} [legs] how far each leg is pulled in, pixels (0 full, 1 half)
 * @property {number} [dots] thought dots over the head, 0-3
 */

/** The animation canvas: room for a jump above the head and a stomp below the feet, inside the frame. */
const CANVAS = { width: 16, height: 14 };
/** Where the mascot's top-left corner sits on the canvas when it stands still. */
const ORIGIN = { x: 1, y: 2 };

const EYES = {
  open: { rows: [2, 3, 4], dx: 0 },
  closed: { rows: [3], dx: 0 },
  left: { rows: [2, 3, 4], dx: -1 },
  right: { rows: [2, 3, 4], dx: 1 },
  up: { rows: [1, 2, 3], dx: 0 },
};

/** The mascot's pixels in a pose, as mascot-relative [x, y] pairs. */
function mascotPixels({ eyes = "open", arms = [0, 0], legs = [0, 0, 0, 0] } = {}) {
  const on = new Set();
  const put = (x, y) => on.add(`${x},${y}`);
  for (let y = 0; y <= 8; y++) for (let x = 2; x <= 11; x++) put(x, y);
  const eye = EYES[eyes];
  for (const y of eye.rows) for (const x of [4, 5, 8, 9]) on.delete(`${x + eye.dx},${y}`);
  for (const y of [4, 5]) {
    for (const x of [0, 1]) put(x, y - arms[0]);
    for (const x of [12, 13]) put(x, y - arms[1]);
  }
  [3, 5, 8, 10].forEach((x, i) => {
    for (let y = 9; y <= 10 - legs[i]; y++) put(x, y);
  });
  return [...on].map((p) => p.split(",").map(Number));
}

/** One canvas frame: the mascot in a pose with its gradient, transparent around it. */
function frame(pose, [top, bottom]) {
  const pixels = Buffer.alloc(CANVAS.width * CANVAS.height * 4);
  const oy = ORIGIN.y + (pose.dy ?? 0);
  for (const [x, y] of mascotPixels(pose)) {
    const cx = ORIGIN.x + x;
    const cy = oy + y;
    if (cx < 0 || cy < 0 || cx >= CANVAS.width || cy >= CANVAS.height) continue;
    // The gradient follows the body, so a jump doesn't change its colours.
    pixels.set([...mix(top, bottom, Math.max(0, y) / 10), 255], (cy * CANVAS.width + cx) * 4);
  }
  // Thought dots rise to the right of the head, one by one.
  for (let i = 0; i < (pose.dots ?? 0); i++) {
    pixels.set([...mix(top, bottom, 0.3), 255 - 60 * (2 - i)], (0 * CANVAS.width + 11 + 2 * i) * 4);
  }
  return png(CANVAS.width, CANVAS.height, 4, pixels);
}

/** A sequence: [pose, frames] steps. */
const step = (frames, pose = {}) => ({ frames, pose });
const repeat = (times, steps) => Array.from({ length: times }, () => steps).flat();

/** Working: it thinks. Looks around, blinks, and thought dots come and go while its eyes are up. */
const THINKING = [
  step(20),
  step(2, { eyes: "closed" }),
  step(14),
  step(10, { eyes: "right" }),
  step(10, { eyes: "left" }),
  step(6),
  ...repeat(2, [step(5, { eyes: "up", dots: 1 }), step(5, { eyes: "up", dots: 2 }), step(7, { eyes: "up", dots: 3 }), step(4, { eyes: "up" })]),
  step(10),
  step(2, { eyes: "closed" }),
  step(3),
  step(2, { eyes: "closed" }),
  step(16),
];

const LANDED = { legs: [1, 1, 1, 1] };
/** Waiting for you: it calls, one thing after another. Jumps, waves, stomps, then catches its breath. */
const CALLING = [
  ...repeat(2, [
    step(1, { dy: -1 }),
    step(2, { dy: -2, arms: [1, 1] }),
    step(1, { dy: -1 }),
    step(2, LANDED),
    step(2),
  ]),
  ...repeat(3, [step(3, { arms: [2, 0] }), step(3, { arms: [0, 2] })]),
  step(5, { arms: [3, 3], eyes: "up" }),
  step(3),
  ...repeat(2, [
    step(3, { legs: [1, 1, 0, 0], eyes: "closed" }),
    step(2, { dy: 1, eyes: "closed" }),
    step(2),
    step(3, { legs: [0, 0, 1, 1], eyes: "closed" }),
    step(2, { dy: 1, eyes: "closed" }),
    step(2),
  ]),
  step(8),
  step(2, { eyes: "closed" }),
  step(8),
];

const BUILD = new URL("../build/frames/", import.meta.url);

/** Writes an animation's frames and meta.json for tools/pack.py. */
function animation(name, steps, fps, colors) {
  const dir = new URL(`${name}/`, BUILD);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let i = 0;
  for (const { frames, pose } of steps) {
    const data = frame(pose, colors);
    for (let k = 0; k < frames; k++) writeFileSync(new URL(`${i++}.png`, dir), data);
  }
  writeFileSync(new URL("meta.json", dir), JSON.stringify({ fps, color_mode: "argb8888", sections: [] }));
  console.log(`build/frames/${name}: ${i} frames, ${(i / fps).toFixed(1)} s`);
}

/** Dashes that run clockwise around the approval frame: 4 px on, 4 px off, one pixel further each frame. */
const DASH = { on: 4, off: 4, color: "#E6C07A", fps: 11 };

function marchingBorder() {
  const width = 72;
  const height = 16;
  // The frame's outline without its cut corners, clockwise from the top left: 168 px, 21 dash periods, no seam.
  const path = [];
  for (let x = 1; x <= width - 2; x++) path.push([x, 0]);
  for (let y = 1; y <= height - 2; y++) path.push([width - 1, y]);
  for (let x = width - 2; x >= 1; x--) path.push([x, height - 1]);
  for (let y = height - 2; y >= 1; y--) path.push([0, y]);
  const period = DASH.on + DASH.off;
  const dir = new URL("border/", BUILD);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let shift = 0; shift < period; shift++) {
    const pixels = Buffer.alloc(width * height * 4);
    path.forEach(([x, y], i) => {
      if ((i - shift + period * path.length) % period < DASH.on) pixels.set([...rgb(DASH.color), 255], (y * width + x) * 4);
    });
    writeFileSync(new URL(`${shift}.png`, dir), png(width, height, 4, pixels));
  }
  writeFileSync(new URL("meta.json", dir), JSON.stringify({ fps: DASH.fps, color_mode: "argb8888", sections: [] }));
  console.log(`build/frames/border: ${period} frames, ${path.length} px around`);
}

/** A still mascot, cut to its own 14x11 box. */
function still(colors) {
  const pixels = Buffer.alloc(14 * 11 * 4);
  for (const [x, y] of mascotPixels()) pixels.set([...mix(colors[0], colors[1], y / 10), 255], (y * 14 + x) * 4);
  return png(14, 11, 4, pixels);
}

for (const [name, style] of Object.entries(STATES)) save(`images/bg_${name}.png`, background(style));
// Working and calling frames show the animations instead.
for (const name of ["done", "idle"]) save(`images/icon_${name}.png`, still(STATES[name].icon));
for (const [name, colors] of Object.entries(LIST_ICONS)) save(`images/list_${name}.png`, icon(SMALL, 4, colors));
animation("thinking", THINKING, 10, ORANGE);
animation("calling", CALLING, 12, ORANGE);
marchingBorder();

/**
 * APPS menu icons. The front one (8x8, colour) is the Claude mascot drawn by hand: src/appmeta/icon_front_8x8.png,
 * not generated. The back one (11x11, greyscale) is the same mascot, arms out, two eyes, two legs.
 */
const BACK = [
  "...........",
  ".#########.",
  ".#########.",
  "###.###.###",
  ".##.###.##.",
  ".#########.",
  ".#########.",
  ".#########.",
  "...#...#...",
  "...#...#...",
  "...........",
];

function icon(rows, channels, [top, bottom]) {
  const size = rows.length;
  const pixels = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    const color = mix(top, bottom, y / (size - 1));
    for (let x = 0; x < size; x++) {
      const on = rows[y][x] === "#";
      const pixel = { 4: on ? [...color, 255] : [0, 0, 0, 0], 2: [255, on ? 255 : 0], 1: [on ? 255 : 0] }[channels];
      pixels.set(pixel, (y * size + x) * channels);
    }
  }
  return png(size, size, channels, pixels);
}

// The back menu paints its icons in the text colour and takes the shape from transparency alone.
save("appmeta/icon_back_11x11.png", icon(BACK, 2, ["#FFFFFF", "#FFFFFF"]));
