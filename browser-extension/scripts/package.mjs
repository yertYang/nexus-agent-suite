import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../manifest.json" with { type: "json" };

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(project, "scripts", "check-ui.mjs")], { stdio: "inherit" });
const archive = join(project, "dist", `navi-link-${manifest.version}.zip`);
const temp = mkdtempSync(join(tmpdir(), "nexus-extension-package-"));
const files = ["manifest.json", "background.js", "content.js", "panel.js", "panel-bridge.js", "panel.html", "panel.css", "team.html", "team.js", "team.css",
  "core/intent.js", "core/baidu-search.mjs", "core/direct-api.js", "core/direct-chat.js", "core/direct-tools.js", "core/browser.js", "core/mcp.js", "core/pair.js", "core/bridge.js", "core/page.js", "core/protocol.js", "README.md", "LICENSE", "NOTICE.md",
  ...["tokens.css", "components.css", "marked-LICENSE", "marked.js", "reply.js", "chevron-down.svg", "manifest.json", "LICENSE"].map((file) => "ui/" + file),
  "icons/navi.svg", ...[16, 32, 48, 128].map((size) => "icons/icon" + size + ".png")];
try {
  for (const filename of files) {
    const file = join(temp, filename);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(project, filename), file);
  }
  mkdirSync(dirname(archive), { recursive: true });
  rmSync(archive, { force: true });
  execFileSync("zip", ["-q", "-X", archive, ...files], { cwd: temp, stdio: "inherit" });
  console.log(archive);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
