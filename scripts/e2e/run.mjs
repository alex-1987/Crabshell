#!/usr/bin/env node
// UI tests against the real app (WebKitGTK) via tauri-driver.
//
//   npm run tauri build -- --debug --no-bundle     # app with embedded frontend
//   node scripts/e2e/run.mjs
//
// Needs `tauri-driver` (cargo install tauri-driver) and WebKitWebDriver (webkit2gtk package).
// The app runs with an empty, temporary config directory, so your servers and settings are untouched.
// A Crabshell window opens briefly on your desktop while the tests run.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY, Session, sleep } from "./webdriver.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const application = process.env.CRABSHELL_APP ?? join(root, "src-tauri", "target", "debug", "crabshell");
const home = mkdtempSync(join(tmpdir(), "crabshell-e2e-"));

// cargo installs into ~/.cargo/bin, which is not always on PATH.
const cargoDriver = join(homedir(), ".cargo", "bin", "tauri-driver");
const driverPath = process.env.TAURI_DRIVER ?? (existsSync(cargoDriver) ? cargoDriver : "tauri-driver");
const driver = spawn(driverPath, [], {
  // A plain /bin/sh: no prompt frameworks or setup wizards from the user's shell config.
  env: { ...process.env, SHELL: "/bin/sh", XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data") },
  stdio: ["ignore", "inherit", "inherit"],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? `  (${detail})` : ""}`);
}

/** Describes the focused element, e.g. "INPUT.terminal-tab-rename" or "TEXTAREA.xterm-helper-textarea". */
const focused = (session) => session.run("const e = document.activeElement; return e ? `${e.tagName}.${e.className}` : 'none';");

let session;
try {
  await sleep(800);
  session = await Session.start(application);
  await session.find(".add-tab-button");

  // --- open a local shell
  await session.click(".add-tab-button");
  await session.find(".xterm");
  await sleep(1200);
  check("local shell tab opens", (await session.run("return document.querySelectorAll('.terminal-tab').length;")) === 1);
  // The session starts on the first fit; no error from an early resize may show up.
  const status = await session.run("return document.querySelector('.terminal-tab-panel-active .status-message')?.textContent;");
  check("shell is connected without an error notice", status === "Connected" || status === "Verbunden", `status: ${status}`);

  // --- rename by double-click
  await session.mouse(".terminal-tab-select", "double");
  await sleep(700);
  let focus = await focused(session);
  check("double-click: name field has the focus", focus.includes("terminal-tab-rename"), focus);
  await session.keys("Logs");
  await session.keys(KEY.enter);
  await sleep(300);
  const title = await session.run("return document.querySelector('.terminal-tab-title')?.textContent;");
  check("double-click: typed name is saved", title === "Logs", `title: ${title}`);

  // --- rename from the tab menu
  await session.mouse(".terminal-tab-select", "right");
  await session.find(".tab-menu");
  await session.click(".tab-menu .context-menu-item");
  await sleep(700);
  focus = await focused(session);
  check("tab menu → rename: name field has the focus", focus.includes("terminal-tab-rename"), focus);
  await session.keys(KEY.escape);
  await sleep(300);
  check("escape keeps the old name", (await session.run("return document.querySelector('.terminal-tab-title')?.textContent;")) === "Logs");

  // --- tab color from the tab menu
  const tabColor = () => session.run("return document.querySelector('.terminal-tab').style.getPropertyValue('--tab-color');");
  await session.mouse(".terminal-tab-select", "right");
  await session.click('.tab-menu-swatch[title="#4f8fe8"]');
  await sleep(200);
  check("tab menu: quick color is applied", (await tabColor()) === "#4f8fe8", await tabColor());
  await session.click(".tab-menu-swatch-default");
  await sleep(200);
  check("tab menu: design color restores the default", (await tabColor()) !== "#4f8fe8", await tabColor());
  await session.keys(KEY.escape);
} catch (error) {
  check("test run", false, error.message);
} finally {
  await session?.end();
  driver.kill();
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
