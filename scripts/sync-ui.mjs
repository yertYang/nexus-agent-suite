// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "design-system", "navi-ui");
const checker = join(root, "scripts", "check-vendored-ui.mjs");
const options = {
  "workbench-dir": { type: "string", default: join(root, "agent-workbench") },
  "extension-dir": { type: "string", default: join(root, "browser-extension") },
  "out-dir": { type: "string", default: join(root, "outputs") },
};
const [mode, ...args] = process.argv.slice(2);
if (!["sync", "check", "pack"].includes(mode)) throw new Error("Use sync, check or pack.");
const { values } = parseArgs({ args, options });
const assets = ["LICENSE", "chevron-down.svg", "components.css", "marked-LICENSE", "marked.js", "reply.js", "tokens.css"];
const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const contents = new Map(await Promise.all(assets.map(async (file) =>
  [file, await readFile(join(source, file))])));
const sha256 = Object.fromEntries([...contents].map(([file, bytes]) =>
  [file, createHash("sha256").update(bytes).digest("hex")]));
contents.set("manifest.json", Buffer.from(JSON.stringify({ package: pkg.name, version: pkg.version, sha256 }, null, 2) + "\n"));
const compare = async (path, expected) => {
  const actual = await readFile(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!actual?.equals(expected)) throw new Error("Outdated Navi UI asset: " + path + " (run npm run ui:sync)");
};
const assertAssets = async (directory) => {
  const expected = [...contents.keys()].sort();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile()) ||
      JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected)) {
    throw new Error("Unexpected or missing files in Navi UI directory: " + directory);
  }
  await Promise.all(expected.map((file) => compare(join(directory, file), contents.get(file))));
};
const manifestPath = join(source, "manifest.json");
if (mode === "sync") await writeFile(manifestPath, contents.get("manifest.json"));
else await compare(manifestPath, contents.get("manifest.json"));

const packageFiles = ["CHANGELOG.md", "README.md", "package.json", "preview.html", "preview.css", "preview.js", ...contents.keys()].sort();
async function verifyArchive(archive) {
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trimEnd().split("\n").sort();
  if (JSON.stringify(names) !== JSON.stringify(packageFiles.map(name => "package/" + name))) {
    throw new Error("Unexpected or missing entries in " + archive + " (run npm run ui:pack)");
  }
  for (const name of packageFiles) {
    const packed = execFileSync("tar", ["-xOzf", archive, "package/" + name]);
    if (!packed.equals(await readFile(join(source, name)))) {
      throw new Error("Stale Navi UI package: " + name + " (run npm run ui:pack)");
    }
  }
}

if (mode === "pack") {
  const destination = resolve(values["out-dir"]);
  await mkdir(destination, { recursive: true });
  const staging = await mkdtemp(join(destination, ".navi-ui-pack-"));
  try {
    const npmArgs = ["pack", "--json", "--ignore-scripts", "--pack-destination", staging];
    const [command, ...argv] = process.env.npm_execpath
      ? [process.execPath, process.env.npm_execpath, ...npmArgs]
      : ["npm", ...npmArgs];
    const [artifact] = JSON.parse(execFileSync(command, argv, { cwd: source, encoding: "utf8" }));
    const entries = artifact.files.map(({ path }) => path).sort();
    if (JSON.stringify(entries) !== JSON.stringify(packageFiles)) throw new Error("Unexpected files in Navi UI npm package.");
    await verifyArchive(join(staging, artifact.filename));
    const archive = join(destination, artifact.filename);
    await rename(join(staging, artifact.filename), archive);
    console.log(archive);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
} else {
  const checkerBytes = await readFile(checker);
  const projects = [
    [resolve(values["workbench-dir"]), "public", "ui"],
    [resolve(values["extension-dir"]), "ui"],
  ];
  for (const [project, ...target] of projects) {
    const localChecker = join(project, "scripts", "check-ui.mjs");
    const directory = join(project, ...target);
    if (mode === "sync") {
      // Require each project to exist before making or updating its asset directory.
      await readFile(join(project, "package.json"));
      await mkdir(directory, { recursive: true });
      await Promise.all([...contents.keys()].map((file) => copyFile(join(source, file), join(directory, file))));
      await copyFile(checker, localChecker);
    }
    await assertAssets(directory);
    await compare(localChecker, checkerBytes);
    console.log(directory);
  }
  if (mode === "check") {
    const archive = resolve(values["out-dir"], pkg.name.replace(/^@/, "").replace("/", "-") + "-" + pkg.version + ".tgz");
    const present = await access(archive).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    if (present) { await verifyArchive(archive); console.log(archive); }
  }
}
