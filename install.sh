#!/bin/bash
# Claude Code on the BUSY Bar: installs everything on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/mrlunev/busybar-claude-code/main/install.sh | bash
#
# 1. Node.js, if missing or older than 20 (Homebrew if present, else the official installer: asks for the password).
# 2. The busybar plugin, through the `claude` command (the terminal one or the desktop app's).
# 3. Setup: finds the bar on the USB cable, installs the app on it, asks to press Start on the bar.
#
# Everything sits in main(), called on the last line: bash reads a piped script as it runs, so a half-downloaded
# script must not start.

# BUSYBAR_SOURCE: a local copy of the repository instead of GitHub, for testing before it is published.
REPO="${BUSYBAR_SOURCE:-mrlunev/busybar-claude-code}"
NODE_LINE="latest-v24.x"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" -ge 20 ]
}

install_node() {
  if command -v brew >/dev/null 2>&1; then
    say "Installing Node.js with Homebrew..."
    brew install node </dev/null || fail "Homebrew could not install Node.js."
    return
  fi
  say "Installing Node.js. Type your Mac password if asked (nothing shows while you type)."
  local name pkg
  name=$(curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt" | awk '/\.pkg$/ { print $2; exit }')
  [ -n "$name" ] || fail "Could not reach nodejs.org. Check the internet connection and run this again."
  pkg="$(mktemp -d)/$name"
  curl -fsSL -o "$pkg" "https://nodejs.org/dist/$NODE_LINE/$name" || fail "Could not download Node.js."
  sudo installer -pkg "$pkg" -target / </dev/tty || fail "Node.js was not installed."
  export PATH="/usr/local/bin:$PATH"
}

# The terminal `claude`, else the one inside the Claude desktop app (newest version).
find_claude() {
  if command -v claude >/dev/null 2>&1; then command -v claude; return; fi
  [ -x "$HOME/.local/bin/claude" ] && { echo "$HOME/.local/bin/claude"; return; }
  ls -d "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1
}

# The newest installed copy of the plugin's daemon.
plugin_daemon() {
  ls -d "$HOME/.claude/plugins/cache/busybar/busybar/"*/daemon/claude-bar-daemon.mjs 2>/dev/null | sort -V | tail -1
}

main() {
  node_ok || install_node
  node_ok || fail "Node.js 20 or newer is needed, and it is still missing."

  local claude daemon
  claude=$(find_claude)
  if [ -n "$claude" ]; then
    say "Installing the busybar plugin for Claude Code..."
    "$claude" plugin marketplace add "$REPO" </dev/null >/dev/null 2>&1 || "$claude" plugin marketplace update busybar </dev/null >/dev/null 2>&1
    "$claude" plugin install busybar@busybar </dev/null || fail "Claude Code could not install the plugin."
    daemon=$(plugin_daemon)
  fi
  if [ -z "$daemon" ]; then
    # No `claude` command here: run setup from a download, the plugin is added inside Claude Code afterwards.
    local dir="$HOME/.busybar-claude-code"
    if [ -d "$REPO" ]; then
      dir="$REPO"
    else
      say "Downloading..."
      rm -rf "$dir" && mkdir -p "$dir"
      curl -fsSL "https://codeload.github.com/$REPO/tar.gz/main" | tar -xz -C "$dir" --strip-components 1 || fail "Could not download the plugin."
    fi
    daemon="$dir/plugin/daemon/claude-bar-daemon.mjs"
  fi

  say "Setting up the bar..."
  node "$daemon" setup </dev/null || exit 1

  if [ -z "$claude" ]; then
    say "Last step: in Claude Code, send these two lines one by one:"
    echo "  /plugin marketplace add $REPO"
    echo "  /plugin install busybar@busybar"
  fi
  say "Restart Claude Code, and your sessions appear on the bar."
}

main "$@"
