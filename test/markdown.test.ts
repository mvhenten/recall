import { describe, expect, it } from "vitest";
import { render } from "../src/markdown";

const BASE = "/a/spec";

const rendered = (markdown: string): string => render(markdown, BASE);

describe("the markdown renderer", () => {
  it("prints markup in the source as characters", () => {
    const html = rendered('Before <script>alert("x")</script> after\n\n<img src=x onerror=y>\n');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=y&gt;");
  });

  it("leaves markup inside a code span and a fence literal", () => {
    expect(rendered("Call `<b>bold</b>` here.\n")).toContain("<code>&lt;b&gt;bold&lt;/b&gt;</code>");
    const fenced = rendered("```\n<div>raw</div>\n```\n");
    expect(fenced).toBe("<pre><code>&lt;div&gt;raw&lt;/div&gt;</code></pre>");
  });

  it("renders the blocks a document uses", () => {
    const html = rendered(
      [
        "# Title",
        "",
        "A paragraph with **bold** and *italic*.",
        "",
        "- one",
        "- two",
        "  - nested",
        "",
        "1. first",
        "2. second",
        "",
        "> quoted",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "---",
        "",
        "    indented code",
      ].join("\n"),
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<ul><li><p>one</p></li>");
    expect(html).toContain("<ul><li><p>nested</p></li></ul>");
    expect(html).toContain("<ol><li><p>first</p></li>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<table><thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<pre><code>indented code</code></pre>");
  });

  it("resolves a relative link and an image under the artifact's own address", () => {
    const html = rendered("[notes](notes.md) ![chart](img/chart.png) [deep](./a/b.txt)\n");
    expect(html).toContain(`href="${BASE}/f/notes.md"`);
    expect(html).toContain(`src="${BASE}/f/img/chart.png"`);
    expect(html).toContain(`href="${BASE}/f/a/b.txt"`);
  });

  it("rebases an absolute same-origin path under the base rather than leaving the artifact", () => {
    const html = rendered("[other](/other-artifact) ![cover](/cover.png) [deep](/sub/dir/x.md)\n");
    expect(html).toContain(`href="${BASE}/f/other-artifact"`);
    expect(html).toContain(`src="${BASE}/f/cover.png"`);
    expect(html).toContain(`href="${BASE}/f/sub/dir/x.md"`);
  });

  it("leaves an absolute address, a fragment and a mail link alone, and refuses any other scheme", () => {
    const html = rendered("[out](https://example.com/x) [top](#title) [mail](mailto:you@example.com)\n");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('href="#title"');
    expect(html).toContain('href="mailto:you@example.com"');
    const refused = rendered("[bad](javascript:alert(1))\n");
    expect(refused).not.toContain("href");
    expect(refused).toContain("[bad]");
  });

  it("writes a base holding two underscores whole rather than reading it back as bold", () => {
    const base = "/link/TyMwx1l2hC19kPLN5FQ__sLnu6N-rryD9PAPizBjW04";
    const html = render("A [link](./appendix.md) and an image: ![cover](/cover.png)\n", base);
    expect(html).toContain(`href="${base}/f/appendix.md"`);
    expect(html).toContain(`src="${base}/f/cover.png"`);
    expect(html).not.toContain("<strong>");
  });

  it("reads emphasis in a link's own text, under a base it may never read", () => {
    const base = "/link/TyMwx1l2hC19kPLN5FQ__sLnu6N-rryD9PAPizBjW04";
    const html = render("[__bold__](./a.md)\n", base);
    expect(html).toBe(`<p><a href="${base}/f/a.md"><strong>bold</strong></a></p>`);
  });

  it("keeps a code span inside an image's alt text", () => {
    const html = rendered("![the `npm ci` output](/shot.png)\n");
    expect(html).toBe(`<p><img src="${BASE}/f/shot.png" alt="the <code>npm ci</code> output"></p>`);
  });

  it("holds a hard break and drops a single newline", () => {
    expect(rendered("one  \ntwo\n")).toBe("<p>one<br>two</p>");
    expect(rendered("one\ntwo\n")).toBe("<p>one two</p>");
  });

  it("renders nothing for nothing", () => {
    expect(rendered("")).toBe("");
    expect(rendered("\n\n  \n")).toBe("");
  });

  it("keeps a relative link inside the artifact and refuses a protocol-relative one", () => {
    const climbed = rendered("[up](../../other/secret.md)\n");
    expect(climbed).toContain(`href="${BASE}/f/other/secret.md"`);
    expect(climbed).not.toContain("..");
    const host = rendered("[out](//evil.example.com/x)\n");
    expect(host).not.toContain("href");
    expect(host).toContain("[out]");
  });

  it("prints a marker the publisher wrote as nothing rather than as markup", () => {
    const held = rendered("Call `one` and \u0000 then `two`.\n");
    expect(held).toContain("<code>one</code>");
    expect(held).toContain("<code>two</code>");
    expect(held).not.toContain("\u0000");
    expect(rendered("line \u0001 break\n")).toBe("<p>line  break</p>");
  });

  it("stops nesting past its ceiling instead of running out of stack", () => {
    const quoted = rendered(`${">".repeat(3_000)} deep\n`);
    expect(quoted).toContain("deep");
    expect(quoted.match(/<blockquote>/g)).toHaveLength(17);
    const listed = rendered(
      Array.from({ length: 2_000 }, (_one, level) => `${" ".repeat(level * 2)}- item ${level}`).join("\n"),
    );
    expect(listed).toContain("item 1999");
    expect(listed.match(/<ul>/g)).toHaveLength(17);
  });
});
