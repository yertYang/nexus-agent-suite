// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const { name } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const paths = { "navi-workbench": "public/ui/", "navi-link": "ui/" };
if (!Object.hasOwn(paths, name)) throw new Error("Unknown Navi UI consumer: " + name);
const directory = new URL(paths[name], root);
const assets = ["LICENSE", "chevron-down.svg", "components.css", "marked-LICENSE", "marked.js", "reply.js", "tokens.css"];
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
const entries = await readdir(directory, { withFileTypes: true });
const expected = [...assets, "manifest.json"].sort();
if (entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected) ||
    manifest.package !== "@navi/ui" || !/^\d+\.\d+\.\d+$/.test(manifest.version ?? "") ||
    JSON.stringify(Object.keys(manifest.sha256 ?? {}).sort()) !== JSON.stringify(assets)) {
  throw new Error("Incomplete or unexpected Navi UI assets: " + fileURLToPath(directory));
}
for (const asset of assets) {
  const digest = createHash("sha256").update(await readFile(new URL(asset, directory))).digest("hex");
  if (digest !== manifest.sha256[asset]) throw new Error("Navi UI asset has changed: " + asset);
}
console.log(name + ": Navi UI " + manifest.version + " is intact.");
