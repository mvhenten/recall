// A session's transcript as the records it is written in, which is the other way the archive takes
// one. The byte path keys an object by where its stretch sits in the file and leaves the reader to
// work out what a line is; a record is one redacted JSONL line verbatim, and its place in the file
// is its ordinal — the position it holds in the records of that file and nothing else.
//
// One object per append, under `records/<user id>/<session id>/<file>/<first ordinal>`. The
// ordinal is zero-padded so a listing sorts in the order the records were written, and the count
// of lines in the object rides in its metadata, since nothing else in the key says where the
// object ends. Beside the count rides the one byte no ordinal accounts for: whether a line break
// closed the last record, which is what makes a readback the file to its final byte rather than
// one short of it.
//
// The `records/` prefix is what keeps the two paths apart in one bucket. A byte-path key is four
// segments and `parseStretchKey` refuses a fifth, so the consumer that indexes the byte path reads
// no record object and no change was needed there.

import type { RecordSpan } from "./transcript-plan";
import type { RecordedFile } from "./transcripts";

// How many records one append may carry, and how many bytes of them. Both are the ceiling the
// endpoint answers 413 against. A record is one line and cannot be split, so the byte ceiling is
// also the longest line the archive can ever take: a `Read` of an image embeds base64 and runs to
// well over a megabyte, and a file holding one would never archive under a lower ceiling.
export const MAX_RECORDS_PER_APPEND = 1000;
export const MAX_RECORDS_BYTES = 5_242_880;

export const RECORDS_PREFIX = "records";

// What a record that is not valid UTF-8 opens with. A record crosses as a JSON string, so a line
// of a tool output holding bytes no encoding reads would go up corrupted and the archive would
// hold prose the host never wrote. Such a line carries its own bytes in base64 behind this marker
// and is decoded back here, so the object holds the bytes the host read and a readback is the file
// to the byte. A line that is valid UTF-8 and opens with the marker is sent the same way, which is
// what makes reading one unambiguous.
export const BINARY_RECORD = "\u0000base64:";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Wide enough that an ordinal can never carry past it: a session writing a record a millisecond
// for a century reaches sixteen digits short of filling it.
const ORDINAL_DIGITS = 16;

// Where the count of lines an object holds is kept. R2 hands custom metadata back with a listing,
// so the reach of a file is one listing and no read of a body.
const HELD = "records";

// Whether a line break closes the last record of an object. A file is its objects laid end to end
// with that break between them, so the one byte no ordinal accounts for is the one that ends a
// record, and a tool output the session stopped writing part way through a line ends without it.
// It rides beside the count because the file it belongs to is read back as a stream of objects and
// nothing else in the archive says where its last line stopped.
const CLOSES = "closes";

const BREAK = 10;

const ENCODER = new TextEncoder();

// One record as the bytes the host read it as. A record that opens with the marker carries those
// bytes in base64 and is decoded; anything else is the string itself.
const recordBytes = (record: string): Uint8Array => {
  if (!record.startsWith(BINARY_RECORD)) return ENCODER.encode(record);
  const raw = atob(record.slice(BINARY_RECORD.length));
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) bytes[at] = raw.charCodeAt(at);
  return bytes;
};

// What is wrong with the first record of an append whose bytes the archive cannot read, and
// nothing where it can read every record. A marker with anything but base64 behind it is a host this archive cannot store for, and decoding it
// where it lands would leave the object holding whatever the decoder made of it; a marker with
// nothing behind it stands for no bytes at all, which is the one way a record the contract holds
// to a character could reach the archive empty.
export const recordsFault = (records: readonly string[]): string => {
  for (const [at, record] of records.entries()) {
    if (!record.startsWith(BINARY_RECORD)) continue;
    const encoded = record.slice(BINARY_RECORD.length);
    if (encoded === "") return `record ${at} carries no bytes behind its marker`;
    if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) return `record ${at} carries no base64 behind its marker`;
  }
  return "";
};

// The body one append is stored as: its records as the host read them, one line break between two.
const recordsBody = (records: readonly string[]): Uint8Array => {
  const parts = records.map(recordBytes);
  const whole = new Uint8Array(parts.reduce((bytes, part) => bytes + part.length, records.length - 1));
  let at = 0;
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      whole[at] = BREAK;
      at += 1;
    }
    whole.set(part, at);
    at += part.length;
  }
  return whole;
};

// Whether the body already stored at an ordinal and the records a writer is offering there are
// the same prose as far as the shorter of them runs. It is weighed whole rather than record by
// record: a record carries the blank lines in front of it, so the breaks in a body do not divide
// it into the records it holds and nothing read back off one could be lined up against them.
export const recordsAgree = (stored: Uint8Array, records: readonly string[]): boolean => {
  const offered = recordsBody(records);
  const held = Math.min(stored.length, offered.length);
  for (let at = 0; at < held; at += 1) {
    if (stored[at] !== offered[at]) return false;
  }
  return true;
};

const sessionPrefix = (userId: string, sessionId: string): string => `${RECORDS_PREFIX}/${userId}/${sessionId}/`;

const filePrefix = (userId: string, sessionId: string, file: string): string =>
  `${sessionPrefix(userId, sessionId)}${file}/`;

const ordinalName = (ordinal: number): string => String(ordinal).padStart(ORDINAL_DIGITS, "0");

const recordKey = (userId: string, sessionId: string, file: string, from: number): string =>
  `${filePrefix(userId, sessionId, file)}${ordinalName(from)}`;

// One record object as its key and its metadata describe it, which is the whole of what the
// archive knows about one: which file it belongs to, the ordinal its first record carries, how
// many it holds, and what it weighs.
interface RecordObject {
  key: string;
  file: string;
  from: number;
  held: number;
  bytes: number;
  closes: boolean;
}

// What a listing does with a key this archive did not write. A writer has to fail on one: the
// reach it weighs an append against comes off the objects, and a listing that passed a key over
// would answer a conflicted writer short of the truth and send it to write over records already
// stored. A reader has to do the opposite — one unreadable key under a session's prefix must not
// take the whole page down — so it reads what it can and the walk says what it could not reach.
type Unwritten = "fail" | "skip";

const readObject = (prefix: string, key: string, size: number, metadata: Record<string, string> | undefined) => {
  const [file, name, ...rest] = key.slice(prefix.length).split("/");
  const from = Number(name);
  const held = Number(metadata?.[HELD]);
  // An object written before the archive kept this byte closes on a break: the record path only
  // ever stored whole lines then, and a reader that threw on the missing value would answer every
  // read of such a session with a fault it could never recover from.
  const closes = metadata?.[CLOSES] ?? "1";
  const wrote =
    file !== undefined &&
    file !== "" &&
    name !== undefined &&
    rest.length === 0 &&
    Number.isSafeInteger(from) &&
    name === ordinalName(from) &&
    Number.isSafeInteger(held) &&
    held > 0 &&
    (closes === "0" || closes === "1");
  if (!wrote) return null;
  return { key, file, from, held, bytes: size, closes: closes === "1" };
};

// Every record object of one file, or of a whole session where no file is named, in the order the
// records were written. A file named here is listed under its own prefix rather than filtered out
// of the session's: a session holds one prefix per file, so a reader after one of them pays for
// that file's objects and not for every delegated turn beside it.
const listRecords = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string | null,
  unwritten: Unwritten,
): Promise<RecordObject[]> => {
  // The file sits inside the key a listing is read against, so a listing of one file opens its own
  // prefix and the key is still read from the session's, which is what keeps one reader of a key.
  const session = sessionPrefix(userId, sessionId);
  const prefix = file === null ? session : filePrefix(userId, sessionId, file);
  const objects: RecordObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    for (const object of page.objects) {
      const read = readObject(session, object.key, object.size, object.customMetadata);
      if (read === null) {
        if (unwritten === "fail") throw new Error(`${object.key} is no record object this archive wrote`);
        continue;
      }
      objects.push(read);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects.sort((left, right) => left.from - right.from);
};

// Where one file ends, counted off the objects and nothing else: how many records of it the
// archive holds, and whether a break closed the last of them. A file whose last record the
// session stopped writing part way through takes no more records — an append behind it would
// store its bytes under an ordinal of their own and the two would read back as one line — so the
// two answers are read together and the objects are what both are read from.
export interface RecordsEnd {
  reach: number;
  closes: boolean;
}

export const recordsEnd = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<RecordsEnd> => {
  const objects = await listRecords(bucket, userId, sessionId, file, "fail");
  const last = objects.at(-1);
  return {
    reach: objects.reduce((reach, object) => Math.max(reach, object.from + object.held), 0),
    closes: last === undefined || last.closes,
  };
};

export const recordsReach = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<number> => (await recordsEnd(bucket, userId, sessionId, file)).reach;

// What a file weighs as the transcript it joins back to: the objects laid end to end, each closed
// by the break that closed its last record.
const weighOf = (objects: readonly RecordObject[]): { bytes: number; records: number } => ({
  bytes: objects.reduce((all, object) => all + object.bytes + (object.closes ? 1 : 0), 0),
  records: objects.reduce((all, object) => Math.max(all, object.from + object.held), 0),
});

const filesOf = (objects: readonly RecordObject[]): RecordedFile[] => {
  const held = new Map<string, RecordObject[]>();
  for (const object of objects) {
    const beside = held.get(object.file);
    if (beside === undefined) held.set(object.file, [object]);
    else beside.push(object);
  }
  return [...held]
    .map(([file, written]): RecordedFile => ({ held: "records", file, ...weighOf(written) }))
    .sort((left, right) => left.file.localeCompare(right.file));
};

const spansOf = (objects: readonly RecordObject[]): RecordSpan[] =>
  objects.map((object) => ({ from: object.from, held: object.held, bytes: object.bytes + (object.closes ? 1 : 0) }));

// The files of a session the record path holds, and what each weighs. Nothing here is a span of a
// file on disk the way a byte-path stretch is — a record is a whole line verbatim, and redaction
// leaves a line at another length than the one the host read — so `bytes` is a length of the
// archive and no place in the file the host holds. How many records of the file the archive has is
// the one count that is a place in both, and a restore weighs a local file against that.
export const recordFiles = async (bucket: R2Bucket, userId: string, sessionId: string): Promise<RecordedFile[]> =>
  filesOf(await listRecords(bucket, userId, sessionId, null, "skip"));

// What a page drawing one file of a session needs, off the one listing that answers both: which
// files the record path holds, and where every object of the chosen one sits. Two listings would
// walk the same prefix twice, and a session is one prefix however many files it delegated.
export interface RecordedTranscript {
  files: RecordedFile[];
  spans: RecordSpan[];
}

export const recordedTranscript = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<RecordedTranscript> => {
  const objects = await listRecords(bucket, userId, sessionId, null, "skip");
  return { files: filesOf(objects), spans: spansOf(objects.filter((object) => object.file === file)) };
};

// Where every object of one file sits in its records, in the order they were written. A reader
// that wants a window of the file rather than the whole of it plans it against these: a window
// opens and ends on an object boundary and nowhere else, which is the one shape a read of one can
// answer, and the weight of each is what the window costs on the wire.
export const recordSpans = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<RecordSpan[]> => spansOf(await listRecords(bucket, userId, sessionId, file, "skip"));

// One file of a session's transcript, read back out of its records. Each object is handed over in
// ordinal order followed by the break that closed its last record, which is the file the host
// sent, byte for byte: a record is one line and an append is a run of them, so the only byte an
// append boundary costs is the one that ends its last line — and the file ends on that same byte
// unless the session stopped writing part way through the line, which is what an object that
// closes on nothing says.
const streamed = (bucket: R2Bucket, objects: readonly RecordObject[], file: string): ReadableStream<Uint8Array> => {
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
      controller.enqueue(new Uint8Array(await body.arrayBuffer()));
      if (object.closes) controller.enqueue(new Uint8Array([BREAK]));
    },
  });
};

export const readRecords = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
): Promise<ReadableStream<Uint8Array> | null> => {
  const objects = await listRecords(bucket, userId, sessionId, file, "fail");
  if (objects.length === 0) return null;
  return streamed(bucket, objects, file);
};

// One window of a file, read back as the bytes of the file it accounts for, or nothing at all
// where the objects do not tile the window exactly. It is the same prose `readRecords` hands over
// and the same byte for byte, bounded to two ordinals, so a reader walking a long transcript pays
// for the window it is showing and no more.
//
// The objects are weighed before a body is opened. A window the archive cannot answer whole is a
// reader and an archive disagreeing about what is stored, and saying so before the response opens
// is what keeps a short read from reaching a box as though it were the file.
export const readRecordWindow = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
  through: number,
): Promise<ReadableStream<Uint8Array> | null> => {
  const objects = (await listRecords(bucket, userId, sessionId, file, "skip")).filter(
    (object) => object.from + object.held > from && object.from < through,
  );
  let at = from;
  for (const object of objects) {
    if (object.from !== at) return null;
    at = object.from + object.held;
  }
  if (at !== through) return null;
  return streamed(bucket, objects, file);
};

// One append read back as the bytes it is stored as, or null where the archive holds no object at
// that ordinal. It is what a writer beaten to its own key reads to find out whether the records
// already stored there are the ones it was sending.
export const readRecordAppend = async (
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  file: string,
  from: number,
): Promise<Uint8Array | null> => {
  const body = await bucket.get(recordKey(userId, sessionId, file, from));
  if (body === null) return null;
  return new Uint8Array(await body.arrayBuffer());
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
  const objects = (await listRecords(bucket, userId, sessionId, file, "fail")).filter(
    (object) => object.from + object.held > from && object.from < through,
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
  closes: boolean,
): Promise<boolean> => {
  const written = await bucket.put(recordKey(userId, sessionId, file, from), recordsBody(records), {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { [HELD]: String(records.length), [CLOSES]: closes ? "1" : "0" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written !== null;
};
