// R2 has no append, so a session's transcript is kept as one object per appended stretch, under
// `<user id>/<session id>/<file>/<start offset>`. The offset is zero-padded, so listing the prefix
// gives the stretches in the order they were written and reading one file is a concatenation. A
// stretch is keyed by where it starts and nothing else, so a tick that retries one writes the same
// key again instead of a second copy of the same lines.
const OFFSET_DIGITS = 16;

// The largest stretch one call may carry. A transcript of any size lands as a run of these.
export const MAX_CHUNK_BYTES = 1_048_576;

export interface TranscriptFile {
  file: string;
  bytes: number;
}

export type Appended = { ok: true; offset: number } | { ok: false; offset: number };

const filePrefix = (userId: string, sessionId: string, file: string): string => `${userId}/${sessionId}/${file}/`;

const chunkKey = (userId: string, sessionId: string, file: string, offset: number): string =>
  `${filePrefix(userId, sessionId, file)}${String(offset).padStart(OFFSET_DIGITS, "0")}`;

const reach = (key: string, size: number): number => {
  const start = Number(key.slice(key.lastIndexOf("/") + 1));
  return Number.isSafeInteger(start) ? start + size : 0;
};

const walk = async (bucket: R2Bucket, prefix: string, take: (key: string, size: number) => void): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const object of page.objects) take(object.key.slice(prefix.length), object.size);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
};

// How far into each of a session's transcript files this service has been written, which is where
// the host that holds them picks up. A file nothing was ever written for is simply absent.
export const transcriptFiles = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
): Promise<TranscriptFile[]> => {
  const held = new Map<string, number>();
  await walk(bucket, `${userId}/${sessionId}/`, (key, size) => {
    const slash = key.lastIndexOf("/");
    if (slash < 1) return;
    const file = key.slice(0, slash);
    held.set(file, Math.max(held.get(file) ?? 0, reach(key, size)));
  });
  return [...held].map(([file, bytes]) => ({ file, bytes })).sort((left, right) => left.file.localeCompare(right.file));
};

const heldBytes = async (bucket: R2Bucket, userId: string, sessionId: string, file: string): Promise<number> => {
  let held = 0;
  await walk(bucket, filePrefix(userId, sessionId, file), (key, size) => {
    held = Math.max(held, reach(key, size));
  });
  return held;
};

// The store is append-only: a stretch lands only where the file already ends, so two writers racing
// on the same file cannot leave an overlap for a reader to see twice. A caller writing anywhere
// else is told where the file ends and reads on from there.
export const appendChunk = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  offset: number,
  body: ArrayBuffer,
): Promise<Appended> => {
  const held = await heldBytes(bucket, userId, sessionId, file);
  if (offset !== held) return { ok: false, offset: held };
  if (body.byteLength === 0) return { ok: true, offset: held };
  await bucket.put(chunkKey(userId, sessionId, file, offset), body, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  return { ok: true, offset: offset + body.byteLength };
};
