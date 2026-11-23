// The back display while nothing is set up on the computer: where to open the bar's web page and where to go
// there; the app's settings hold the guide (the FAQ link and the installer commands). Text widths below were
// measured on the back display; its drawable width is 148 px, right of it is the firmware's status bar.

export interface WebAddress {
  how: "Wi-Fi" | "USB";
  address: string;
}

// Types, not interfaces: the elements go into the app's own element list, which takes any plain object with an id.
type Base = {
  id: string;
  display: "back";
  x: number;
  y: number;
  z_index: number;
};
export type HelpElement =
  | (Base & { type: "text"; align: "top_left"; text: string; font: "bold" | "normal" | "extra_large"; color: string })
  | (Base & { type: "rectangle"; width: number; height: number; radius: number; fill: "solid"; fill_colors: string[]; border_width: number })
  | (Base & { type: "xpmbitmap"; align: "top_left"; data: string });

const BACK_W = 148;
const WHITE = "#FFFFFFFF";
const GREY = "#909090FF";
const BLACK = "#000000FF";

// Layout. `normal`, `bold` and `extra_large` all start their glyphs 2 px below the element's y.
const LINE = 12;
const TAG_H = 14; // 10 px address digits, 2 px above and below
const TAG_STEP = TAG_H + 2;

// Measured widths.
const NAME_W = { "Wi-Fi": 25, USB: 17 } as const; // `normal`
const APPS_W = 24; // "Apps" in `bold`
const SPACE = 5; // around the arrow; a font space would be 6, which pushes the line past 148
const ARROW_W = 6;

/** "192.168.1.101" in `extra_large`: digits 7 px, "1" 4, "." 2, 1 px between glyphs. */
function addressWidth(address: string): number {
  let w = address.length - 1;
  for (const c of address) w += c === "1" ? 4 : c === "." ? 2 : 7;
  return w;
}

// Icons copied pixel for pixel from the firmware's status bar.
const WIFI = [
  ".######.",
  "#......#",
  "..####..",
  ".#....#.",
  "........",
  "...##...",
  "...##...",
];
const USB_UPRIGHT = [
  "...#....",
  "..###...",
  ".#####..",
  "...#....",
  "...#.###",
  "##.#..#.",
  "##.#.#..",
  ".#.##...",
  "..##....",
  "...#....",
  "..###...",
  "..###...",
];
/** Turned a quarter clockwise: the plug points right. */
const USB = USB_UPRIGHT[0].split("").map((_, x) => USB_UPRIGHT.map((row) => row[x]).reverse().join(""));
/** The font's own arrow, as in the mockup; the firmware substitutes a heavier one for "→". */
const ARROW = ["...#..", "....#.", "######", "....#.", "...#.."];

function xpm(rows: readonly string[], color: string): string {
  return ["! XPM2", `${rows[0].length} ${rows.length} 2 1`, ". c none", `# c ${color.slice(0, 7)}`, ...rows].join("\n");
}

export function helpElements(addresses: readonly WebAddress[]): HelpElement[] {
  const out: HelpElement[] = [];
  let y = 0;
  // Ids are unique per element and position, never reused for another type: the firmware refuses a type change.
  const text = (key: string, x: number, at: number, value: string, font: "bold" | "normal" | "extra_large", color: string) =>
    out.push({ id: `help_${key}`, type: "text", display: "back", align: "top_left", x, y: at, text: value, font, color, z_index: 2 });
  const picture = (key: string, x: number, at: number, rows: readonly string[], color: string) =>
    out.push({ id: `help_${key}`, type: "xpmbitmap", display: "back", align: "top_left", x, y: at, data: xpm(rows, color), z_index: 2 });
  const line = (key: string, value: string, font: "bold" | "normal" = "normal", color = GREY) => {
    text(key, 0, y, value, font, color);
    y += LINE;
  };

  const tag = (n: number, a: WebAddress) => {
    const top = y + 1;
    const icon = a.how === "Wi-Fi" ? WIFI : USB;
    const iconW = icon[0].length;
    const addressW = addressWidth(a.address);
    // Padding 3, icon, 3, name, 5, address, 4. The name goes when there is no room for it.
    const full = 3 + iconW + 3 + NAME_W[a.how] + 5 + addressW + 4;
    const named = full <= BACK_W;
    const addressX = named ? full - 4 - addressW : 3 + iconW + 5;
    out.push({ id: `help_tag${n}`, type: "rectangle", display: "back", x: 0, y: top, width: addressX + addressW + 4, height: TAG_H, radius: 3, fill: "solid", fill_colors: [WHITE], border_width: 0, z_index: 1 });
    picture(`tag${n}_icon`, 3, top + Math.floor((TAG_H - icon.length) / 2), icon, BLACK);
    if (named) text(`tag${n}_name`, 3 + iconW + 3, top + 1, a.how, "normal", BLACK);
    text(`tag${n}_address`, addressX, top, a.address, "extra_large", BLACK);
    y += TAG_STEP;
  };

  // Not set up, then: open this in a browser, Apps → Claude Code Sessions, and follow the guide there.
  // The name is in `normal`: in `bold` (118 px) it would not fit after the arrow.
  line("title", "Not set up yet", "bold", WHITE);
  line("open", addresses.length > 0 ? "Open in a browser:" : "Plug in by USB, open:");
  const list = addresses.length > 0 ? addresses.slice(0, 2) : [{ how: "USB", address: "10.0.4.20" } as const];
  list.forEach((a, n) => tag(n, a));
  const arrowX = APPS_W + SPACE;
  text("apps", 0, y, "Apps", "bold", WHITE);
  picture("arrow", arrowX, y + 3, ARROW, WHITE); // centred on the 7 px capitals
  text("app", arrowX + ARROW_W + SPACE, y, "Claude Code Sessions", "normal", WHITE);
  y += LINE;
  line("follow", "and follow the guide there");
  return out;
}

/** Where the bar's web page opens: its Wi-Fi address when the API is open there, and USB when a computer may be on the cable. */
export async function webAddresses(api: string): Promise<WebAddress[]> {
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      const res = await fetch(`${api}${path}`);
      // Read the body either way so the firmware can free the connection.
      const body = await res.text();
      return res.ok ? (JSON.parse(body) as T) : null;
    } catch {
      return null;
    }
  };
  const wifi = await get<{ state?: string; ip_config?: { address?: string } }>("wifi/status");
  const access = await get<{ mode?: string }>("access");
  const power = await get<{ usb_voltage?: number }>("status/power");
  const out: WebAddress[] = [];
  if (wifi?.state === "connected" && wifi.ip_config?.address && access?.mode === "enabled") out.push({ how: "Wi-Fi", address: wifi.ip_config.address });
  // A charger cannot be told from a computer's port.
  if ((power?.usb_voltage ?? 0) > 4000) out.push({ how: "USB", address: "10.0.4.20" });
  return out;
}
