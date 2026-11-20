#!/usr/bin/env node
// Builds the app and puts a clean copy of the bundle in ../plugin/release/, which goes out with the plugin:
//
//   npm run release
//
// busy-cli packs with the system tar. On macOS that records the user's name and file attributes
// (com.apple.provenance) in the headers and adds ._* files, which the emulator refuses. The bundle is repacked as
// plain ustar owned by nobody in particular.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "app.mrlunev.claude_code";
const env = { ...process.env, COPYFILE_DISABLE: "1" };

execSync("busy-cli build", { cwd: APP, stdio: "inherit", env });

const tmp = mkdtempSync(path.join(os.tmpdir(), "busybar-release-"));
try {
  execFileSync("tar", ["-xzf", path.join(APP, "dist", `${NAME}.tgz`), "-C", tmp], { env });
  const out = path.join(APP, "..", "plugin", "release", `${NAME}.tgz`);
  mkdirSync(path.dirname(out), { recursive: true });
  const clean = ["--format", "ustar", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"];
  if (process.platform === "darwin") clean.push("--no-xattrs", "--no-mac-metadata");
  execFileSync("tar", [...clean, "-czf", out, "-C", tmp, NAME], { env });
  console.log(`release: ${path.relative(APP, out)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
