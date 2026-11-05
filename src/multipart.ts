// The publish's body, read one part at a time off the request stream. `request.formData()` buffers
// the whole body, and an artifact of 64 MB buffered twice does not fit a Worker isolate, so each
// file part is piped straight into storage as it arrives and nothing larger than one chunk is held.
//
// Nothing here throws. A body that stops mid-part, a part over its ceiling and a body that names
// no part at all are all answers the caller turns into a status, because every one of them is a
// request a client can send and none of them is a fault of the service.

type Bytes = Uint8Array<ArrayBufferLike>;

const encoder = new TextEncoder();

const CRLF = "\r\n";

export interface PartHead {
  name: string;
  filename: string;
}

const BOUNDARY = /boundary=(?:"([^"]+)"|([^;\s]+))/i;

export const boundaryOf = (contentType: string): string | null => {
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return null;
  const found = BOUNDARY.exec(contentType);
  const boundary = found?.[1] ?? found?.[2] ?? "";
  return boundary === "" ? null : boundary;
};

const concat = (left: Bytes, right: Bytes): Bytes => {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
};

const matchesAt = (haystack: Bytes, needle: Bytes, at: number): boolean => {
  for (let index = 0; index < needle.length; index += 1) {
    if (haystack[at + index] !== needle[index]) return false;
  }
  return true;
};

const indexOf = (haystack: Bytes, needle: Bytes): number => {
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (matchesAt(haystack, needle, at)) return at;
  }
  return -1;
};

const DISPOSITION = /^content-disposition:\s*form-data(.*)$/im;
const FIELD = /;\s*name=(?:"([^"]*)"|([^;\s]*))/i;
const FILENAME = /;\s*filename=(?:"([^"]*)"|([^;\s]*))/i;

const headOf = (headers: string): PartHead => {
  const disposition = DISPOSITION.exec(headers)?.[1] ?? "";
  const field = FIELD.exec(disposition);
  const filename = FILENAME.exec(disposition);
  return { name: field?.[1] ?? field?.[2] ?? "", filename: filename?.[1] ?? filename?.[2] ?? "" };
};

export interface MultipartBody {
  // The next part's headers, or null where the body holds no further part. Anything left unread of
  // the part before it is skipped.
  nextPart(): Promise<PartHead | null>;
  // The current part as text, or null where it holds more than `limit` bytes.
  text(limit: number): Promise<string | null>;
  // The current part written into a stream as it arrives, so storage sees the bytes while the
  // request is still being received. A part that does not hold exactly `exact` bytes aborts the
  // stream rather than closing it, which is what stops a short or a lying part from being stored.
  pipe(into: WritableStream<Bytes>, exact: number): Promise<{ ok: boolean; bytes: number }>;
}

export const readMultipart = (body: ReadableStream<Bytes>, boundary: string): MultipartBody => {
  const reader = body.getReader();
  const delimiter = encoder.encode(`--${boundary}`);
  const closing = encoder.encode(`${CRLF}--${boundary}`);
  const headEnd = encoder.encode(`${CRLF}${CRLF}`);
  const dashes = encoder.encode("--");
  let held: Bytes = new Uint8Array(0);
  let drained = false;
  let started = false;
  let inPart = false;

  const pull = async (): Promise<boolean> => {
    if (drained) return false;
    const { done, value } = await reader.read();
    if (done) {
      drained = true;
      return false;
    }
    held = concat(held, value);
    return true;
  };

  const take = (count: number): Bytes => {
    const taken = held.slice(0, count);
    held = held.slice(count);
    return taken;
  };

  // The next bytes of the current part, or null once the part has ended. A chunk is held back by
  // one byte less than the delimiter, because the delimiter may straddle two reads.
  const chunk = async (): Promise<Bytes | null> => {
    if (!inPart) return null;
    for (;;) {
      const at = indexOf(held, closing);
      if (at !== -1) {
        const part = take(at);
        take(closing.length);
        inPart = false;
        return part.length === 0 ? null : part;
      }
      const keep = closing.length - 1;
      if (held.length > keep) return take(held.length - keep);
      if (!(await pull())) {
        inPart = false;
        const rest = take(held.length);
        return rest.length === 0 ? null : rest;
      }
    }
  };

  const skip = async (): Promise<void> => {
    while (inPart) await chunk();
  };

  // How much of the current part is left, for a refusal that wants to say how big the part really
  // was rather than where it gave up counting.
  const rest = async (): Promise<number> => {
    let bytes = 0;
    for (;;) {
      const next = await chunk();
      if (next === null) return bytes;
      bytes += next.length;
    }
  };

  const start = async (): Promise<boolean> => {
    for (;;) {
      const at = indexOf(held, delimiter);
      if (at !== -1) {
        take(at + delimiter.length);
        started = true;
        return true;
      }
      if (!(await pull())) return false;
    }
  };

  return {
    async nextPart(): Promise<PartHead | null> {
      await skip();
      if (!started && !(await start())) return null;
      while (held.length < 2 && (await pull())) {
        // the loop condition reads what the delimiter is followed by
      }
      if (held.length < 2 || matchesAt(held, dashes, 0)) return null;
      take(2);
      for (;;) {
        const at = indexOf(held, headEnd);
        if (at !== -1) {
          const headers = new TextDecoder().decode(take(at));
          take(headEnd.length);
          inPart = true;
          return headOf(headers);
        }
        if (!(await pull())) return null;
      }
    },
    async text(limit: number): Promise<string | null> {
      const reading = new TextDecoder();
      let text = "";
      let bytes = 0;
      for (;;) {
        const next = await chunk();
        if (next === null) return text;
        bytes += next.length;
        if (bytes > limit) {
          await skip();
          return null;
        }
        text += reading.decode(next, { stream: true });
      }
    },
    async pipe(into: WritableStream<Bytes>, exact: number): Promise<{ ok: boolean; bytes: number }> {
      const writer = into.getWriter();
      const refuse = async (bytes: number): Promise<{ ok: boolean; bytes: number }> => {
        await skip();
        await writer.abort(new RangeError(`this part holds ${bytes} bytes and not ${exact}`));
        return { ok: false, bytes };
      };
      let bytes = 0;
      for (;;) {
        const next = await chunk();
        if (next === null) {
          if (bytes !== exact) return refuse(bytes);
          await writer.close();
          return { ok: true, bytes };
        }
        bytes += next.length;
        if (bytes > exact) return refuse(bytes + (await rest()));
        await writer.write(next);
      }
    },
  };
};
