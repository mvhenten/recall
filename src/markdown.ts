import { escapeHtml } from "./page";

// recall's markdown, rendered in the Worker on every read of a document. The subset is the one a
// published document uses: headings, paragraphs, nested lists, fenced and indented code, inline
// code, bold, italic, links, images, tables, blockquotes, rules and hard breaks.
//
// There is no "allow HTML" mode to leave on. Every character of the source is escaped before a tag
// is written around it, so markup a publisher wrote in the markdown prints as characters and a bug
// in this parser is a rendering fault rather than an injection.

// Inline code is lifted out before anything else runs over the text, so emphasis and link
// syntax inside a code span stays literal. A publisher's markdown may hold the marker itself, so
// `render` strips both markers from the source before a line of it is read.
const HELD = "\u0000";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

// A relative link is resolved against the artifact's own prefix and may not climb out of it: a
// `..` that would leave `/<name>/` is dropped rather than addressing another artifact's files.
const within = (name: string, target: string): string | null => {
  const cut = target.search(/[?#]/);
  const path = cut === -1 ? target : target.slice(0, cut);
  const suffix = cut === -1 ? "" : target.slice(cut);
  const kept: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return kept.length === 0 ? null : `/${encodeURIComponent(name)}/${kept.join("/")}${suffix}`;
};

// A document is served at `/<name>` with no trailing slash and its page sets `base-uri 'none'`, so
// a relative link cannot be resolved by the browser or by a <base> tag. It is resolved here, into
// the address the artifact's own files answer on. A `//host/path` names another host rather than
// this one's root, so it is refused with everything else that leaves the deployment.
const resolveUrl = (raw: string, name: string): string | null => {
  const target = raw.trim();
  if (target === "") return null;
  if (target.startsWith("#")) return target;
  if (target.startsWith("//")) return null;
  if (target.startsWith("/")) return target;
  const scheme = SCHEME.exec(target);
  if (scheme) return SAFE_SCHEMES.includes(scheme[0].toLowerCase()) ? target : null;
  return within(name, target);
};

const inline = (text: string, name: string): string => {
  const codes: string[] = [];
  const spans = text.replace(/`([^`]+)`/g, (_whole, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${HELD}${codes.length - 1}${HELD}`;
  });
  const marked = escapeHtml(spans)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt: string, src: string) => {
      const url = resolveUrl(src, name);
      return url === null ? whole : `<img src="${url}" alt="${alt}">`;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
      const url = resolveUrl(href, name);
      return url === null ? whole : `<a href="${url}">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_]+)_/g, "$1<em>$2</em>");
  return marked.replace(new RegExp(`${HELD}(\\d+)${HELD}`, "g"), (whole, at: string) => codes[Number(at)] ?? whole);
};

// A line ending in two spaces is a break the author asked for and a single newline is not, so the
// two are marked apart before the text is escaped and written back as a tag afterwards.
const BREAK = "\u0001";

const paragraph = (lines: string[], name: string): string => {
  const joined = lines
    .map((line, index) => {
      const text = line.trimEnd();
      if (index === lines.length - 1) return text;
      return /\s{2,}$/.test(line) ? `${text}${BREAK}` : `${text}\n`;
    })
    .join("");
  return `<p>${inline(joined, name).replaceAll(BREAK, "<br>").replaceAll("\n", " ")}</p>`;
};

const codeBlock = (lines: string[]): string => `<pre><code>${escapeHtml(lines.join("\n"))}</code></pre>`;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isDivider = (line: string): boolean => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim()) && line.includes("-");

const indent = (line: string): number => /^(\s*)/.exec(line)?.[1]?.length ?? 0;

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

const marker = (line: string): RegExpExecArray | null => BULLET.exec(line) ?? NUMBER.exec(line);

// One list, items and all. An item's first line carries its marker and every line indented past it
// belongs to the item, so a nested list is the same renderer run over the lines the item holds.
const list = (lines: string[], at: number, name: string, depth: number): { html: string; next: number } => {
  const first = lines[at] ?? "";
  const ordered = NUMBER.test(first);
  const base = indent(first);
  const items: string[][] = [];
  let index = at;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const found = marker(line);
    if (found && indent(line) === base && NUMBER.test(line) === ordered) {
      items.push([found[1] ?? ""]);
      index += 1;
      continue;
    }
    const current = items[items.length - 1];
    if (current === undefined) break;
    if (line.trim() === "") {
      const following = lines[index + 1] ?? "";
      if (following.trim() === "" || indent(following) <= base) break;
      current.push("");
      index += 1;
      continue;
    }
    if (indent(line) <= base) break;
    current.push(line.slice(base + 2));
    index += 1;
  }
  const tag = ordered ? "ol" : "ul";
  const body = items.map((item) => `<li>${blocks(item, name, depth + 1)}</li>`).join("");
  return { html: `<${tag}>${body}</${tag}>`, next: index };
};

const table = (lines: string[], at: number, name: string): { html: string; next: number } => {
  const head = cells(lines[at] ?? "")
    .map((cell) => `<th>${inline(cell, name)}</th>`)
    .join("");
  const rows: string[] = [];
  let index = at + 2;
  while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
    rows.push(
      `<tr>${cells(lines[index] ?? "")
        .map((cell) => `<td>${inline(cell, name)}</td>`)
        .join("")}</tr>`,
    );
    index += 1;
  }
  return { html: `<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`, next: index };
};

const quote = (lines: string[], at: number, name: string, depth: number): { html: string; next: number } => {
  const held: string[] = [];
  let index = at;
  while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
    held.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
    index += 1;
  }
  return { html: `<blockquote>${blocks(held, name, depth + 1)}</blockquote>`, next: index };
};

const fenced = (lines: string[], at: number): { html: string; next: number } => {
  const held: string[] = [];
  let index = at + 1;
  while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
    held.push(lines[index] ?? "");
    index += 1;
  }
  return { html: codeBlock(held), next: index + 1 };
};

const indented = (lines: string[], at: number): { html: string; next: number } => {
  const held: string[] = [];
  let index = at;
  while (index < lines.length && (/^ {4}/.test(lines[index] ?? "") || (lines[index] ?? "").trim() === "")) {
    if ((lines[index] ?? "").trim() === "" && !/^ {4}/.test(lines[index + 1] ?? "")) break;
    held.push((lines[index] ?? "").slice(4));
    index += 1;
  }
  return { html: codeBlock(held), next: index };
};

// How deep a list or a quote may nest before the rest is printed as text. A quote and a list each
// recurse once per level, so without this a three-kilobyte document of nothing but `>` runs the
// renderer out of stack or out of CPU; the ceiling on a document's size bounds neither.
const MAX_DEPTH = 16;

const blocks = (lines: string[], name: string, depth: number): string => {
  if (depth > MAX_DEPTH) return lines.length === 0 ? "" : paragraph(lines, name);
  const out: string[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const block = fenced(lines, at);
      out.push(block.html);
      at = block.next;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      at += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${inline(heading[2] ?? "", name)}</h${level}>`);
      at += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const block = quote(lines, at, name, depth);
      out.push(block.html);
      at = block.next;
      continue;
    }
    if (line.trim().startsWith("|") && isDivider(lines[at + 1] ?? "")) {
      const block = table(lines, at, name);
      out.push(block.html);
      at = block.next;
      continue;
    }
    if (marker(line)) {
      const block = list(lines, at, name, depth);
      out.push(block.html);
      at = block.next;
      continue;
    }
    if (/^ {4}/.test(line)) {
      const block = indented(lines, at);
      out.push(block.html);
      at = block.next;
      continue;
    }
    const held: string[] = [];
    while (at < lines.length) {
      const next = lines[at] ?? "";
      if (next.trim() === "" || FENCE.test(next) || HEADING.test(next) || RULE.test(next) || marker(next)) break;
      if (/^\s*>/.test(next)) break;
      held.push(next);
      at += 1;
    }
    out.push(paragraph(held, name));
  }
  return out.join("");
};

export const render = (markdown: string, name: string): string =>
  blocks(markdown.replaceAll(HELD, "").replaceAll(BREAK, "").replaceAll("\r\n", "\n").split("\n"), name, 0);
