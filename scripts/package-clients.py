"""Build both README downloads from release inputs; do not copy a live workbench."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "downloads"
WB = ROOT / "agent-workbench"
EXT = ROOT / "browser-extension"
# These globs intentionally do not traverse installation directories or .runtime.
WORKBENCH = [
    "LICENSE", "README.md", "package.json", "scripts/*.mjs", "src/*.mjs",
    "team/*.mjs", "team/public/*.js", "team/public/*.html", "team/public/*.css",
    "public/*.html", "public/*.css", "public/*.js", "public/*.svg",
    "public/ui/LICENSE", "public/ui/marked-LICENSE", "public/ui/manifest.json",
    "public/ui/*.js", "public/ui/*.svg", "public/ui/*.css",
    "patches/nexus-office/01-office-read.patch", "patches/nexus-office/LOCK.json",
    "patches/nexus-office/office-text.ts", "patches/nexus-office/README.md",
    "vendor/LOCK.json", "vendor/cpr-v3.49.0/compose.yaml",
    "vendor/cpr-v3.49.0/local.compose.yaml", "vendor/cpr-v3.49.0/config.example.yaml",
    "vendor/licenses/*.txt", "vendor/source/Nexus.tar.gz", "vendor/source/codex-proxy-rs.tar.gz",
    "examples/browser-lab/*.mjs", "examples/browser-lab/README.md", "examples/browser-lab/fixture.html",
    "examples/browser-lab/package.json", "examples/browser-lab/package-lock.json",
    "examples/browser-lab/case.example.json",
]
BUNDLE = [
    "Contents/Info.plist", "Contents/MacOS/Qizhou", "Contents/Resources/BUILD.md",
    "Contents/Resources/Navi.icns", "Contents/Resources/launch.zsh", "Contents/Resources/launcher.c",
    "Contents/_CodeSignature/CodeResources",
]

def pack_entry(z, name, data, executable=False):
    item = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    item.create_system = 3
    item.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    z.writestr(item, data, compress_type=zipfile.ZIP_DEFLATED)

def desktop_files():
    files = {ROOT / "重启 Navi.command", *(ROOT / "Navi.app" / p for p in BUNDLE)}
    for pattern in WORKBENCH:
        hits = list(WB.glob(pattern))
        if not hits:
            raise SystemExit(f"Missing desktop input: {pattern}")
        files.update(hits)
    lock = json.loads((WB / "vendor/LOCK.json").read_text())
    for key, name in (("nexus", "Nexus.tar.gz"), ("codexProxyRs", "codex-proxy-rs.tar.gz")):
        if hashlib.sha256((WB / "vendor/source" / name).read_bytes()).hexdigest() != lock[key]["archiveSha256"]:
            raise SystemExit(f"Vendor checksum mismatch: {name}")
    return sorted(files)

def main():
    subprocess.run(["node", str(WB / "scripts/check-ui.mjs")], check=True)
    subprocess.run(["node", str(EXT / "scripts/package.mjs")], check=True)
    ver = json.loads((EXT / "manifest.json").read_text())["version"]
    OUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=OUT) as temp:
        stage = Path(temp)
        # Reuse the extension's release file list; normalize ZIP dates and modes.
        with zipfile.ZipFile(EXT / "dist" / f"navi-link-{ver}.zip") as src, zipfile.ZipFile(stage / "navi-link.zip", "w") as dest:
            for name in sorted(src.namelist()):
                rel = PurePosixPath(name)
                if rel.is_absolute() or ".." in rel.parts or name.endswith("/"):
                    raise ValueError(f"Invalid extension entry: {name}")
                pack_entry(dest, name, src.read(name))
        with zipfile.ZipFile(stage / "navi-desktop-macos.zip", "w") as z:
            for p in desktop_files():
                if not p.is_file() or p.resolve() != p:
                    raise ValueError(f"Expected a regular desktop input: {p}")
                pack_entry(z, "Navi/" + p.relative_to(ROOT).as_posix(), p.read_bytes(), bool(p.stat().st_mode & 0o111))
        artifacts = sorted(stage.glob("*.zip"))
        lines = []
        for path in artifacts:
            with zipfile.ZipFile(path) as z:
                if z.testzip() is not None:
                    raise ValueError(f"Invalid ZIP: {path.name}")
            lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
        (stage / "SHA256SUMS").write_text("".join(lines), encoding="ascii")
        for p in [*artifacts, stage / "SHA256SUMS"]:
            os.replace(p, OUT / p.name)
            print("downloads/" + p.name)

if __name__ == "__main__":
    main()
