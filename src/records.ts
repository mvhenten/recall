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

import type { TranscriptFile } from "./transcripts";

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

const sessionPrefix = (userId: string, sessionId: string): string => `${RECORDS_PREFIX}/${userId}/${sessionId}/`;

const ordinalName = (ordinal: number): string => String(ordinal).padStart(ORDINAL_DIGITS, "0");

const recordKey = (userId: string, sessionId: string, file: string, from: number): string =>
  `${sessionPrefix(userId, sessionId)}${file}/${ordinalName(from)}`;

// One record object as its key and its metadata describe it, which is the whole of what the
// archive knows about one: which file it belongs to, the ordinal its first record carries, how
// many it holds, and what it weighs.
interface RecordObject {
  key: string;
  file: string;
  from: number;
  held: number;
  bytes: number;
}

// Every record object of one session, in the order the records were written. An object whose name
// or count will not read is a key this archive did not write. Skipping it would answer a
// conflicted writer a reach short of the truth and send it to write over records already stored,
// so the listing fails instead.
const listRecords = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<RecordObject[]> => {
  const prefix = sessionPrefix(userId, sessionId);
  const objects: RecordObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    for (const object of page.objects) {
      const [file, name, ...rest] = object.key.slice(prefix.length).split("/");
      const from = Number(name);
      const held = Number(object.customMetadata?.[HELD]);
      const wrote =
        file !== undefined &&
        file !== "" &&
        rest.length === 0 &&
        Number.isSafeInteger(from) &&
        name === ordinalName(from) &&
        Number.isSafeInteger(held) &&
        held > 0;
      if (!wrote) throw new Error(`${object.key} is no record object this archive wrote`);
      objects.push({ key: object.key, file, from, held, bytes: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects.sort((left, right) => left.from - right.from);
};

// How many records of one file the archive holds, counted off the objects and nothing else. It is
// read only where the mark and the objects disagree — a replay, or a writer beaten to a place — so
// an append in the ordinary case pays for no listing at all.
export const recordsReach = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<number> => {
  const objects = await listRecords(bucket, userId, sessionId);
  return objects
    .filter((object) => object.file === file)
    .reduce((reach, object) => Math.max(reach, object.from + object.held), 0);
};

// The files of a session the record path holds, and what each weighs as the transcript it joins
// back to: the objects laid end to end with the newline that divides two appends. Nothing here is
// a span of a file on disk the way a byte-path stretch is — a record is a whole line verbatim —
// so the archive accounts for every byte of what it holds and for no byte it does not.
export const recordFiles = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<TranscriptFile[]> => {
  const weighed = new Map<string, number>();
  for (const object of await listRecords(bucket, userId, sessionId)) {
    const bytes = weighed.get(object.file);
    weighed.set(object.file, bytes === undefined ? object.bytes : bytes + object.bytes + 1);
  }
  return [...weighed]
    .map(([file, bytes]): TranscriptFile => ({ file, bytes, through: bytes, named: true }))
    .sort((left, right) => left.file.localeCompare(right.file));
};

// One file of a session's transcript, read back out of its records. The objects are handed over in
// ordinal order with a newline between them, which is the file the host sent: a record is one
// JSONL line and an append is a run of them, so the only byte an append boundary costs is the one
// that ends its last line.
export const readRecords = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<ReadableStream<Uint8Array> | null> => {
  const objects = (await listRecords(bucket, userId, sessionId)).filter((object) => object.file === file);
  if (objects.length === 0) return null;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const object = objects[next];
      if (object === undefined) {
        controller.close();
        return;
      }
      next += 1;
      const body = await bucket.get(object.key);
      if (body === null) throw new Error(`the archive lost ${object.key} of ${file}`);
      if (next > 1) controller.enqueue(new Uint8Array([10]));
      controller.enqueue(new Uint8Array(await body.arrayBuffer()));
    },
  });
};

// One append read back as the records it holds, or null where the archive holds no object at that
// ordinal. It is what a writer beaten to its own key reads to find out whether the records already
// stored there are the ones it was sending.
export const readRecordAppend = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
): Promise<string[] | null> => {
  const body = await bucket.get(recordKey(userId, sessionId, file, from));
  if (body === null) return null;
  return (await body.text()).split("\n");
};

// The records of one file between two ordinals. An append whose `from` runs ahead of the mark is
// carrying the index over records the archive already holds and nothing ever read for turns, so it
// reads them back and indexes them with its own.
//
// The objects have to tile the span exactly. A gap or an overlap is an archive no append can read
// its own history out of, and indexing a short read would put the chunks of one ordinal under
// another; it fails instead.
export const readRecordsBetween = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  through: number,
): Promise<string[]> => {
  if (through <= from) return [];
  const objects = (await listRecords(bucket, userId, sessionId)).filter(
    (object) => object.file === file && object.from + object.held > from && object.from < through,
  );
  const records: string[] = [];
  let at = from;
  for (const object of objects) {
    if (object.from !== at) throw new Error(`${file} of ${sessionId} holds no records at ordinal ${at}`);
    const body = await bucket.get(object.key);
    if (body === null) throw new Error(`the archive lost ${object.key} of ${file}`);
    records.push(...(await body.text()).split("\n"));
    at = object.from + object.held;
  }
  if (at !== through) throw new Error(`${file} of ${sessionId} holds no records at ordinal ${at}`);
  return records;
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
