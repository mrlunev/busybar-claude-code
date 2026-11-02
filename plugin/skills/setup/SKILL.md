---
name: setup
description: Connect Claude Code to a BUSY Bar - find the bar, install the "Claude Code" app on it, and start the bridge. Run once after installing the plugin.
disable-model-invocation: true
---

Set up the BUSY Bar for this computer.

1. Run this command with the Bash tool (or PowerShell on Windows without Git Bash), with a timeout of 10 minutes (600000 ms): it waits for the person to press Start on the bar.

   ```
   node "${CLAUDE_PLUGIN_ROOT}/daemon/claude-bar-daemon.mjs" setup
   ```

2. Relay what it prints to the user, briefly and in the user's language. If it asks the person to do something (connect the bar, press Start), say so plainly.

3. If `node` is not found, Node.js is not installed. Tell the user how to install it, then run `/busybar:setup` again in a new session:
   - macOS: `brew install node`, or the LTS installer from https://nodejs.org
   - Windows: `winget install OpenJS.NodeJS.LTS`, or the LTS installer from https://nodejs.org (then restart Claude Code so `node` is on PATH)

To remove the app and the bridge later: `node "${CLAUDE_PLUGIN_ROOT}/daemon/claude-bar-daemon.mjs" uninstall`.
