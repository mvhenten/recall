// A session's transcript as the records it is written in, which is the other way the archive takes
// one. The byte path keys an object by where its stretch sits in the file and leaves the reader to
// work out what a line is; a record is one redacted JSONL line verbatim, and its place in the file
// is its ordinal — the position it holds in the records of that file and nothing else.
//
// One object per append, under `records/<user id>/<session id>/<file>/<first ordinal>`. The
// ordinal is zero-padded so a listing sorts in the order the records were written, and the count
// of lines in the object rides in its metadata, since nothing else in the key says where the
// object ends. Those two numbers are the whole of what the archive knows about a record object.
//
// The `records/` prefix is what keeps the two paths apart in one bucket. A byte-path key is four
// segments and `parseStretchKey` refuses a fifth, so the consumer that indexes the byte path reads
// no record object and no change was needed there.

// How many records one append may carry, and how many bytes of them. Both are the ceiling the
// endpoint answers 413 against, and the byte ceiling is the one the byte path already holds a
// stretch to.
export const MAX_RECORDS_PER_APPEND = 1000;
export const MAX_RECORDS_BYTES = 1_048_576;

export const RECORDS_PREFIX = "records";

// Wide enough that an ordinal can never carry past it: a session writing a record a millisecond
// for a century reaches sixteen digits short of filling it.
const ORDINAL_DIGITS = 16;

// Where the count of lines an object holds is kept. R2 hands custom metadata back with a listing,
// so the reach of a file is one listing and no read of a body.
const HELD = "records";

const filePrefix = (userId: string, sessionId: string, file: string): string =>
  `${RECORDS_PREFIX}/${userId}/${sessionId}/${file}/`;

export const ordinalName = (ordinal: number): string => String(ordinal).padStart(ORDINAL_DIGITS, "0");

export const recordKey = (userId: string, sessionId: string, file: string, from: number): string =>
  `${filePrefix(userId, sessionId, file)}${ordinalName(from)}`;

// How many records of one file the archive holds, counted off the objects and nothing else. It is
// read only where the mark and the objects disagree — a replay, or a writer beaten to a place — so
// an append in the ordinary case pays for no listing at all.
//
// An object whose name or count will not read is a key this archive did not write. Skipping it
// would answer a conflicted writer a reach short of the truth and send it to write over records
// already stored, so the listing fails instead.
export const recordsReach = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<number> => {
  const prefix = filePrefix(userId, sessionId, file);
  let reach = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    for (const object of page.objects) {
      const from = Number(object.key.slice(prefix.length));
      const held = Number(object.customMetadata?.[HELD]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(held) || from < 0 || held < 1) {
        throw new Error(`${object.key} is no record object this archive wrote`);
      }
      reach = Math.max(reach, from + held);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return reach;
};

// One append of one file, which lands only where nothing is yet. Two writers holding the same
// `from` both reach here and the conditional put settles which of them the archive keeps; the
// loser is answered `false` and told the real reach rather than writing over the records the
// winner stored.
export const putRecords = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  records: readonly string[],
): Promise<boolean> => {
  const written = await bucket.put(recordKey(userId, sessionId, file, from), records.join("\n"), {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { [HELD]: String(records.length) },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written !== null;
};
