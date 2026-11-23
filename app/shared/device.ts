/**
 * The requests the app makes to the BUSY Bar it runs on, over plain `fetch`.
 *
 * Not `BusyBar` from @busy-app/busy-lib: that client puts a 3 s timeout on every request through
 * `AbortController`, which is a stub in the firmware. When the bar is busy for longer, the timeout's `abort()`
 * throws an uncaught `TypeError: Expected a function` on the device and the draw is lost. It also calls
 * `Response.clone()`, which the firmware lacks, so every refusal turns into the same TypeError.
 */

export const BASE = `${__BUSY_ADDR__.indexOf("://") >= 0 ? __BUSY_ADDR__ : `http://${__BUSY_ADDR__}`}/api/`;

async function call(method: string, path: string, body?: unknown): Promise<string> {
  // The firmware's fetch rejects `headers: undefined`, so the keys are only set when there is a body.
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(BASE + path, init);
  // Read the body either way so the firmware can free the connection.
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 80)}`);
  return text;
}

export const device = {
  async DisplayDraw(params: { application_name: string; priority?: number; elements: unknown[]; led_notification_color?: string }): Promise<void> {
    await call("POST", "display/draw", params);
  },

  /** Without `element_ids`, everything the app drew. The firmware refuses the whole call if one of the ids is gone. */
  async DisplayClear(params: { application_name: string; element_ids?: string[] }): Promise<void> {
    // application_name goes in the body only: the firmware refuses it in both places.
    await call("DELETE", "display/draw", params);
  },

  async AppsSettingsGet(params: { app_id: string }): Promise<{ values: Record<string, unknown> }> {
    return JSON.parse(await call("GET", `apps/settings?app_id=${params.app_id}`)) as { values: Record<string, unknown> };
  },
};
