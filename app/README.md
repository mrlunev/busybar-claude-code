# Claude Code on the BUSY Bar: the app

The app for the bar, in this folder; the Claude Code plugin it talks to is in [`../plugin`](../plugin). Shows your Claude Code sessions on the BUSY Bar and lets you answer permission prompts with the bar's buttons.

- **Session list** (what the app opens with): two rows at a time, each a small mascot coloured by the session's state, the project folder (the one the session started in) and the task timer. The wheel moves the cursor and scrolls; the name under the cursor scrolls when it is long; a thin bar on the right shows where you are in a longer list. Start or the wheel button opens the session, Back leaves the app.
- **One session**, opened from the list: what it is doing now (`Edit client.ts`, `Bash npm test`), how long the current task has been running, and the project folder right after the timer. A blue-grey frame while it works, green once it is done and waiting for you (the time then stops at how long the task took), amber when it asks you something. On green and amber the bottom line takes the frame's tint.
- **The mascot** stays orange while it works and while it waits for you (green once done). Working, it thinks: looks around, blinks, thought dots rise over its head. Waiting for you, it calls: jumps, waves, stomps, one after another.
Back returns to the list.
- **A session that asks you something** (a question, a plan, or the question the Claude desktop app shows with buttons at the end of a turn) turns amber and scrolls the question; in the list it moves to the top with an amber mascot. The bar can only show it: the answer is a new chat message, which hooks cannot send.
- **Permission prompt:** covers everything else. "Approve?" and the project and command scroll on the first line, Yes / No below (the picked one dark on a bright amber plate), dashes run clockwise around the frame, and the LED blinks amber for as long as the prompt waits. The wheel picks Yes or No, Start (or the wheel button) answers. Back hands the prompt to the terminal: Claude Code then asks there as usual. Several prompts queue up; `+N` shows how many more wait.
- **Context bar** (optional, in the settings): the bottom edge of the frame fills up with the session's context window.

## Install

See the [repository's README](../README.md): one command installs Node.js if needed, the Claude Code plugin and this app, and pairs them. You need Claude Code and a BUSY Bar on firmware 1.3.1 or newer (1.4.1 is the current release).

## How it works

[`../plugin/`](../plugin) is a Claude Code plugin (no `package.json` on purpose: Claude Code would otherwise install the app's npm dependencies into the plugin):

- `daemon/claude-bar-daemon.mjs` runs on the computer (Node 20+, no dependencies). Claude Code posts every session event to it through the plugin's `http` hooks (`hooks/hooks.json`). A `PermissionRequest` hook is held open until the bar answers (or the session moves on, or 590 s pass) and is then answered with `allow`, `deny`, or no decision at all, which leaves the prompt to the terminal. The same request arriving twice (old hooks in `~/.claude/settings.json` plus the plugin's) makes one prompt; setup run from the plugin removes the old hooks, with a backup.
- `daemon/setup.mjs` is setup, uninstall and `--ensure`; `daemon/bar-api.mjs` talks to the bar's HTTP API (install, launch, settings); `daemon/mdns.mjs` finds bars on the network (they announce `busybar-<usb mac>._http._tcp`), in plain Node so it works on Windows too.
- `release/app.mrlunev.claude_code.tgz` is this app, built. Rebuild it with `npm run release` here before committing app changes (`tools/release.mjs` repacks it as plain ustar: macOS tar otherwise records your user name and file attributes in it and adds `._*` files).

The app long-polls `GET /state` on the daemon (a reply comes as soon as something changes, or after 3 s) and redraws only the elements that changed. Running timers are `countdown` elements, so the bar counts them itself. Answers go to `POST /answer`. The `host` setting may list several `address:port` entries; the app sticks with the one that answers. Its screens say what is wrong: "Run setup" (no token), "Wrong token", "Not paired" (the daemon doesn't know this bar's address), "No computer", "Update app" (the daemon is newer).

An "allow" runs a command on the computer, so the daemon serves the bar only with its token and only to known bar addresses (`bars` in `~/.config/busy-claude-bar/config.json`). When the router gives the paired bar a new address, a request with the right token from it is let in once mDNS confirms the address belongs to that bar. Hooks are accepted from the computer itself only.

## Development

```sh
npm install
npm run daemon                          # the daemon in the foreground, with its log
npm run daemon -- --demo                # three made-up sessions and a prompt every 20 s, for filming
npm run build && npm run app:install && npm run app:run
```

Without the plugin, `node ../plugin/daemon/claude-bar-daemon.mjs --install-hooks` puts the same hooks into `~/.claude/settings.json` (after a backup); `--print-hooks` shows them first. Sessions started before do not see new hooks until restarted.

`npm run images` regenerates the frames and mascots in `src/images/` and the two animations in `src/animations/` from `tools/make-images.mjs`; `tools/pack.py` encodes the animation frames with the firmware's `seq2anim.py` (needs a [busybar-firmware](https://github.com/busy-app/busybar-firmware) checkout next to this repository, or its path in `FIRMWARE`, and Pillow). Stop the app before reinstalling it (`npm run app:stop`): the firmware can't replace an app whose animation is playing.

The app talks to the bar it runs on over plain `fetch` (`shared/device.ts`), not through busy-lib's `BusyBar` client, whose 3 s timeout relies on `AbortController`, a stub in the firmware.

## License

MIT, see [LICENSE](../LICENSE). Claude and Claude Code are trademarks of Anthropic, PBC. This app is not made by or affiliated with Anthropic.
