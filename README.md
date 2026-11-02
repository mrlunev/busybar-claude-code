# Claude Code on the BUSY Bar

See all your Claude Code sessions on the BUSY Bar and approve their requests with the bar's buttons.

You need: a BUSY Bar, Claude Code, and a USB cable.

## macOS

1. Connect the bar to your Mac with the USB cable.
2. Open Terminal and paste:
   ```
   curl -fsSL https://raw.githubusercontent.com/mrlunev/busybar-claude-code/main/install.sh | bash
   ```
   If it asks for your Mac password, type it and press Return.
3. When the bar shows **Approve? Setup**, press **Start** on the bar.

Done. Unplug the cable and restart Claude Code.

## Windows

1. Connect the bar to your PC with the USB cable.
2. Open PowerShell and paste:
   ```
   irm https://raw.githubusercontent.com/mrlunev/busybar-claude-code/main/install.ps1 | iex
   ```
   When Windows asks to allow changes, click **Yes**.
3. When the bar shows **Approve? Setup**, press **Start** on the bar.

Done. Unplug the cable and restart Claude Code.

## Using it

- The wheel scrolls through your sessions, **Start** opens one, **Back** goes back.
- When Claude asks for permission, the bar blinks. Turn the wheel to pick **Yes** or **No**, then press **Start**.
- Something wrong? The bar says what. Run the same command again to fix most of it.

## Remove

Run `/plugin uninstall busybar` in Claude Code, then delete the app on the bar in the BUSY app.
