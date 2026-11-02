// R2 has no append, so a session's transcript is kept as one object per appended stretch, under
// `<user id>/<session id>/<file>/<start offset>`. The offset is zero-padded, so listing the prefix
// gives the stretches in the order they were written and reading one file is a concatenation. A
// stretch is keyed by where it starts and nothing else, so a tick that retries one writes the same
// key again instead of a second copy of the same lines.
//
// Where a file ends is kept in D1 beside the session rather than counted off the objects. A
// running session appends every few seconds, so listing the prefix on every call would cost a
// listing that grows with the session and make archiving a long one quadratic.
const OFFSET_DIGITS = 16;

// The largest stretch one call may carry. A transcript of any size lands as a run of these.
export const MAX_CHUNK_BYTES = 1_048_576;

export interface TranscriptFile {
  file: string;
  bytes: number;
}

export type Appended = { ok: true; offset: number } | { ok: false; offset: number };

const chunkKey = (userId: string, sessionId: string, file: string, offset: number): string =>
  `${userId}/${sessionId}/${file}/${String(offset).padStart(OFFSET_DIGITS, "0")}`;

// How far into each of a session's transcript files this service has been written, which is where
// the host that holds them picks up. A file nothing was ever written for is simply absent.
export const transcriptFiles = async (db: D1Database, userId: string, sessionId: string): Promise<TranscriptFile[]> => {
  const { results } = await db
    .prepare("SELECT file, bytes FROM transcript_files WHERE user_id = ? AND session_id = ? ORDER BY file")
    .bind(userId, sessionId)
    .all<TranscriptFile>();
  return results;
};

const heldBytes = async (db: D1Database, userId: string, sessionId: string, file: string): Promise<number> => {
  const row = await db
    .prepare("SELECT bytes FROM transcript_files WHERE user_id = ? AND session_id = ? AND file = ?")
    .bind(userId, sessionId, file)
    .first<{ bytes: number }>();
  return row?.bytes ?? 0;
};

// The store is append-only: a stretch lands only where the file already ends, so two writers racing
// on the same file cannot leave an overlap for a reader to see twice. A caller writing anywhere
// else is told where the file ends and reads on from there.
//
// The object goes down before the end moves. A write that lands and then fails to move the end
// leaves the next stretch starting where this one did, which rewrites the same key with the same
// lines and more of them; the other order would leave a gap no reader could see.
export const appendChunk = async (
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  offset: number,
  body: ArrayBuffer,
): Promise<Appended> => {
  const held = await heldBytes(db, userId, sessionId, file);
  if (offset !== held) return { ok: false, offset: held };
  if (body.byteLength === 0) return { ok: true, offset: held };
  await bucket.put(chunkKey(userId, sessionId, file, offset), body, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  const end = offset + body.byteLength;
  await db
    .prepare(
      `INSERT INTO transcript_files (user_id, session_id, file, bytes) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, session_id, file) DO UPDATE SET bytes = ?4 WHERE transcript_files.bytes = ?5`,
    )
    .bind(userId, sessionId, file, end, offset)
    .run();
  return { ok: true, offset: end };
};
