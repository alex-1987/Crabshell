#!/usr/bin/env node
// Sets the app version everywhere it is stored:
// package.json, package-lock.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock.
//
//   node scripts/set-version.mjs 0.2.1
//   node scripts/set-version.mjs v0.2.1     (a leading "v" or "v." is stripped, so a git tag works too)
//
// Prints the normalized version on stdout.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = (process.argv[2] ?? "").trim();
const version = input.replace(/^v\.?/i, "");

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error(`Invalid version "${input}". Expected e.g. 0.2.1, v0.2.1 or v0.2.1-beta.1`);
  process.exit(1);
}

function edit(file, change) {
  const path = join(root, file);
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after === before && !before.includes(version)) {
    console.error(`Could not find a version to replace in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, after);
}

function editJson(file, change) {
  edit(file, (text) => {
    const data = JSON.parse(text);
    change(data);
    return `${JSON.stringify(data, null, 2)}\n`;
  });
}

editJson("package.json", (data) => { data.version = version; });
editJson("package-lock.json", (data) => {
  data.version = version;
  if (data.packages?.[""]) data.packages[""].version = version;
});
editJson("src-tauri/tauri.conf.json", (data) => { data.version = version; });
// Only the version line inside [package], not dependency versions.
edit("src-tauri/Cargo.toml", (text) => text.replace(/(\[package\][^[]*?\nversion\s*=\s*)"[^"]*"/, `$1"${version}"`));
// Keep Cargo.lock in sync so `cargo ... --locked` still works.
edit("src-tauri/Cargo.lock", (text) => text.replace(/(\[\[package\]\]\nname = "crabshell"\nversion = )"[^"]*"/, `$1"${version}"`));

console.log(version);
