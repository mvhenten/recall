import { describe, expect, it } from "vitest";
import { boundaryOf, readMultipart } from "../src/multipart";

const bodyOf = (text: string): ReadableStream<Uint8Array> => {
  const body = new Response(text.replaceAll("\n", "\r\n")).body;
  if (body === null) throw new Error("a Response built from a string has a body");
  return body;
};

// One part per chunk is the easy case; a body delivered a byte at a time puts every delimiter
// across a read boundary, which is the case a buffer-per-read parser gets wrong.
const byteByByte = (text: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text.replaceAll("\n", "\r\n"));
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + 1));
      at += 1;
    },
  });
};

// Somewhere for a part to be written, reading back what arrived. A refused part aborts the stream,
// so the text is only read where the part was taken.
const sink = (): { writable: WritableStream<Uint8Array>; text: () => Promise<string> } => {
  const relay = new TransformStream<Uint8Array, Uint8Array>();
  // Read as the bytes arrive, the way storage does: a reader that only starts once the part is
  // written would stall the writer on its own backpressure.
  // A refused part aborts the stream, which is what makes storage drop what it had; the reader
  // answers nothing rather than leaving that refusal unhandled.
  const read = new Response(relay.readable).text().catch(() => "");
  return { writable: relay.writable, text: () => read };
};

const BODY = [
  "--xyz",
  'content-disposition: form-data; name="manifest"',
  "",
  '{"type":"site"}',
  "--xyz",
  'content-disposition: form-data; name="file"; filename="index.html"',
  "content-type: text/html",
  "",
  "<p>one</p>",
  "--xyz",
  'content-disposition: form-data; name="file"; filename="style.css"',
  "",
  "p{color:red}",
  "--xyz--",
  "",
].join("\n");

describe("the multipart reader", () => {
  it("names the boundary of a form body alone", () => {
    expect(boundaryOf("multipart/form-data; boundary=xyz")).toBe("xyz");
    expect(boundaryOf('multipart/form-data; boundary="a b"')).toBe("a b");
    expect(boundaryOf("application/json")).toBeNull();
    expect(boundaryOf("multipart/form-data")).toBeNull();
  });

  it("reads every part in order, however the body arrives", async () => {
    for (const body of [bodyOf(BODY), byteByByte(BODY)]) {
      const parts = readMultipart(body, "xyz");
      const manifest = await parts.nextPart();
      expect(manifest?.name).toBe("manifest");
      expect(await parts.text(1_000)).toBe('{"type":"site"}');

      const first = await parts.nextPart();
      expect(first).toEqual({ name: "file", filename: "index.html" });
      const one = sink();
      expect(await parts.pipe(one.writable, 10)).toEqual({ ok: true, bytes: 10 });
      expect(await one.text()).toBe("<p>one</p>");

      const second = await parts.nextPart();
      expect(second?.filename).toBe("style.css");
      const two = sink();
      expect(await parts.pipe(two.writable, 12)).toEqual({ ok: true, bytes: 12 });
      expect(await two.text()).toBe("p{color:red}");

      expect(await parts.nextPart()).toBeNull();
      expect(parts.truncated()).toBe(false);
    }
  });

  it("skips a part the caller never read", async () => {
    const parts = readMultipart(bodyOf(BODY), "xyz");
    await parts.nextPart();
    await parts.nextPart();
    const second = await parts.nextPart();
    expect(second?.filename).toBe("style.css");
  });

  it("refuses a part that does not hold what was declared, and says what it held", async () => {
    const parts = readMultipart(bodyOf(BODY), "xyz");
    await parts.nextPart();
    await parts.text(1_000);
    await parts.nextPart();
    expect(await parts.pipe(sink().writable, 4)).toEqual({ ok: false, bytes: 10 });
    expect((await parts.nextPart())?.filename).toBe("style.css");
  });

  it("refuses a part shorter than what was declared", async () => {
    const parts = readMultipart(bodyOf(BODY), "xyz");
    await parts.nextPart();
    await parts.text(1_000);
    await parts.nextPart();
    expect(await parts.pipe(sink().writable, 99)).toEqual({ ok: false, bytes: 10 });
  });

  it("refuses a part of text over its ceiling", async () => {
    const parts = readMultipart(bodyOf(BODY), "xyz");
    await parts.nextPart();
    expect(await parts.text(4)).toBeNull();
    expect((await parts.nextPart())?.filename).toBe("index.html");
  });

  it("says when the body stopped inside a part", async () => {
    const parts = readMultipart(bodyOf(BODY.slice(0, BODY.indexOf("<p>one</p>") + 4)), "xyz");
    await parts.nextPart();
    await parts.text(1_000);
    await parts.nextPart();
    expect(await parts.pipe(sink().writable, 4)).toEqual({ ok: true, bytes: 4 });
    expect(parts.truncated()).toBe(true);
  });

  it("answers no part for a body that holds none", async () => {
    const parts = readMultipart(bodyOf("not a multipart body at all\n"), "xyz");
    expect(await parts.nextPart()).toBeNull();
  });
});
