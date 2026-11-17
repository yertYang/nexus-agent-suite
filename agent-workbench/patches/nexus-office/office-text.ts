// SPDX-License-Identifier: AGPL-3.0-only
import { inflateRawSync } from "node:zlib";

type Entry = { flags: number; method: number; compressed: number; size: number; offset: number };
type Kind = "xlsx" | "docx";
type Row = { ref: string; text: string };
type Segment = { name: string; start: number; ignored: boolean };

const MAX_ZIP = 8 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_PART = 8 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_TEXT = 500_000;
const no = (message: string): never => { throw new Error(message); };
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const tagName = (value: string) => value.split(":").at(-1)!;

class OfficeZip {
  private entries = new Map<string, Entry>();
  private boundary: number;
  private bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
    if (bytes.length < 22 || bytes.length > MAX_ZIP) no("Unsupported Office archive size");
    let end = bytes.length - 22;
    const min = Math.max(0, end - 65_535);
    while (end >= min && (bytes.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length)) end--;
    if (end < min || bytes.readUInt32LE(end + 4) !== 0) no("Invalid or encrypted Office archive");
    const count = bytes.readUInt16LE(end + 10);
    const directory = bytes.readUInt32LE(end + 16);
    if (!count || count !== bytes.readUInt16LE(end + 8) || count > MAX_ENTRIES ||
      directory + bytes.readUInt32LE(end + 12) !== end) no("Unsupported Office archive directory");
    this.boundary = directory;
    let cursor = directory, total = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) no("Invalid Office archive entry");
      const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
      const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
      const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30);
      const comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
      if (cursor + 46 + length + extra + comment > end || bytes.readUInt16LE(cursor + 34) !== 0 ||
        (flags & 0x2041) || ![0, 8].includes(method) || size > MAX_PART || offset >= directory ||
        compressed > MAX_ZIP || (!compressed && size) || (method === 0 && compressed !== size)) {
        no("Encrypted or oversized Office archive entry");
      }
      const name = decode(bytes.subarray(cursor + 46, cursor + 46 + length));
      if (!name || name.startsWith("/") || /[\\\u0000-\u001f]/.test(name) || name.split("/").includes("..") ||
        this.entries.has(name) || /(?:^|\/)(?:vbaproject|vbadata|macrosheets)(?:[/.]|$)/i.test(name)) {
        no("Unsafe or macro-enabled Office archive entry");
      }
      total += size;
      if (total > MAX_EXPANDED) no("Office archive expands beyond its limit");
      this.entries.set(name, { flags, method, compressed, size, offset });
      cursor += 46 + length + extra + comment;
    }
    if (cursor !== end) no("Invalid Office archive directory length");
  }
  has(name: string) { return this.entries.has(name); }
  xml(name: string): string {
    const entry = this.entries.get(name);
    if (!entry) return no("Missing Office XML part");
    const b = this.bytes, o = entry.offset;
    if (o + 30 > this.boundary || b.readUInt32LE(o) !== 0x04034b50 ||
      b.readUInt16LE(o + 6) !== entry.flags || b.readUInt16LE(o + 8) !== entry.method) no("Mismatched Office ZIP header");
    const length = b.readUInt16LE(o + 26), extra = b.readUInt16LE(o + 28);
    const start = o + 30 + length + extra;
    if (start + entry.compressed > this.boundary || decode(b.subarray(o + 30, o + 30 + length)) !== name) {
      no("Invalid Office ZIP data range");
    }
    const packed = b.subarray(start, start + entry.compressed);
    const plain = entry.method === 8 ? inflateRawSync(packed, { maxOutputLength: entry.size + 1 }) : packed;
    if (plain.length !== entry.size) no("Office archive length mismatch");
    const xml = decode(plain);
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) no("DTD and entities are unsupported in Office files");
    return xml;
  }
}

function xmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g, (token) => {
    const key = token.slice(1, -1);
    if (key[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[key]!;
    const code = key[1] === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}
function xmlAttr(src: string, key: string): string {
  const re = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const a of src.matchAll(re)) if (a[1] === key || tagName(a[1]!) === key) return xmlText(a[2] ?? a[3] ?? "");
  return "";
}
function scan(xml: string, event: (phase: "open" | "close", name: string, value: string) => void) {
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  const stack: Segment[] = [];
  let count = 0, roots = 0;
  for (const token of xml.matchAll(tags)) {
    if (++count > 300_000 || stack.length > 80) no("Office XML is too complex");
    const qualified = token[2];
    if (!qualified) continue;
    const name = tagName(qualified), close = token[1] === "/", fields = token[3] ?? "";
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== qualified) no("Malformed Office XML structure");
      if (!top!.ignored) {
        const raw = ["t", "v"].includes(name) ? xml.slice(top!.start, Math.min(token.index!, top!.start + 8192)) : "";
        event("close", name, xmlText(raw));
      }
      continue;
    }
    if (!stack.length && ++roots > 1) no("Multiple Office XML roots");
    const ignored = !!stack.at(-1)?.ignored || ["del", "instrText"].includes(name);
    if (!ignored) event("open", name, fields);
    if (/\/\s*$/.test(fields)) {
      if (!ignored) event("close", name, "");
    } else stack.push({ name: qualified, start: token.index! + token[0].length, ignored });
  }
  if (stack.length || roots !== 1) no("Invalid Office XML document");
}
const normalize = (value: string, limit = 2048) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  .replace(/\s+/g, " ").trim().slice(0, limit);

export function officeText(bytes: Buffer, kind: Kind): { lines: string[]; warnings: string[]; truncated: boolean } {
  const zip = new OfficeZip(bytes);
  const rows: Row[] = [];
  const warnings = new Set<string>();
  let output = 0, truncated = false;
  function add(ref: string, value: string) {
    const text = normalize(value);
    if (!text) return;
    if (value.length > 2048) truncated = true;
    if (rows.length >= MAX_ROWS || output + ref.length + text.length > MAX_TEXT) { truncated = true; return; }
    rows.push({ ref, text });
    output += text.length + ref.length;
  }
  const contentTypes = zip.xml("[Content_Types].xml");
  if (/macroEnabled|vnd\.ms-office\.vbaProject/i.test(contentTypes)) no("Macro-enabled Office documents are unsupported");

  if (kind === "docx") {
    let paragraph = 0, value: string | null = null, tables = 0;
    const frames: { table: number; row: number; cell: number }[] = [];
    scan(zip.xml("word/document.xml"), (phase, name, fields) => {
      if (phase === "open") {
        if (name === "tbl") frames.push({ table: ++tables, row: 0, cell: 0 });
        if (name === "tr" && frames.length) { frames.at(-1)!.row++; frames.at(-1)!.cell = 0; }
        if (name === "tc" && frames.length) frames.at(-1)!.cell++;
        if (name === "p") { paragraph++; value = ""; }
        if (value !== null && ["br", "tab"].includes(name)) value += " ";
      } else if (name === "t" && value !== null) {
        if (value.length < 4096) value += fields;
        else truncated = true;
      } else if (name === "p" && value !== null) {
        const frame = frames.at(-1);
        add(frame ? `表${frame.table} 行${frame.row} 列${frame.cell} · 段落${paragraph}` : `段落${paragraph}`, value);
        value = null;
      } else if (name === "tbl") frames.pop();
    });
    warnings.add("仅提取 Word 正文和表格；不读取宏、嵌入对象或外链。");
  } else {
    const members = new Map<string, string>();
    const sheets: { id: string; name: string }[] = [];
    scan(zip.xml("xl/workbook.xml"), (phase, name, attrs) => {
      if (phase === "open" && name === "sheet") {
        const sheet = { id: xmlAttr(attrs, "r:id") || xmlAttr(attrs, "id"),
          name: normalize(xmlAttr(attrs, "name"), 90) };
        if (sheet.id && sheet.name && sheets.length < 128) sheets.push(sheet);
        else truncated = true;
      }
    });
    scan(zip.xml("xl/_rels/workbook.xml.rels"), (phase, name, attrs) => {
      if (phase !== "open" || name !== "Relationship") return;
      const type = xmlAttr(attrs, "Type");
      const target = xmlAttr(attrs, "Target");
      if (!type.endsWith("/worksheet")) return;
      if (xmlAttr(attrs, "TargetMode").toLowerCase() === "external") { warnings.add("已忽略外部工作表。"); return; }
      const path = target.startsWith("/xl/") ? target.slice(1) : "xl/" + target;
      if (!/^xl\/worksheets\/[\w.-]+\.xml$/.test(path)) no("Unsafe worksheet relationship");
      members.set(xmlAttr(attrs, "Id"), path);
    });
    const shared: string[] = [];
    if (zip.has("xl/sharedStrings.xml")) {
      let value: string | null = null;
      scan(zip.xml("xl/sharedStrings.xml"), (phase, name, fields) => {
        if (phase === "open" && name === "si") value = "";
        if (phase === "close" && name === "t" && value !== null && value.length < 4096) value += fields;
        if (phase === "close" && name === "si" && value !== null) {
          if (shared.length > 24_000) no("Too many Office shared strings");
          shared.push(value);
          value = null;
        }
      });
    }
    for (const sheet of sheets) {
      const part = members.get(sheet.id);
      if (!part) { warnings.add("部分工作表关系不可用。"); continue; }
      let cell: { ref: string; type: string; text: string; val: string; formula: boolean } | null = null;
      scan(zip.xml(part), (phase, name, fields) => {
        if (phase === "open" && name === "c") {
          const ref = xmlAttr(fields, "r");
          cell = { ref: /^[A-Z]{1,4}[1-9]\d{0,7}$/.test(ref) ? ref : "", type: xmlAttr(fields, "t"),
            val: "", text: "", formula: false };
        } else if (cell && phase === "open" && name === "f") cell.formula = true;
        else if (cell && phase === "close" && name === "t" && cell.text.length < 4096) cell.text += fields;
        else if (cell && phase === "close" && name === "v") cell.val = fields;
        else if (cell && phase === "close" && name === "c") {
          const text = cell.type === "s" && /^\d+$/.test(cell.val) ? shared[Number(cell.val)] ?? ""
            : cell.type === "inlineStr" ? cell.text : cell.type === "b" ? cell.val === "1" ? "TRUE" : "FALSE" : cell.val;
          if (cell.formula) warnings.add("公式未执行；只读取工作簿已有的缓存值。");
          if (cell.ref) add(sheet.name + "!" + cell.ref, text);
          cell = null;
        }
      });
    }
    warnings.add("仅提取 Excel 单元格；不会加载外链或运行宏。");
  }
  return { lines: rows.map(({ ref, text }) => ref + "\t" + text), warnings: [...warnings], truncated };
}
