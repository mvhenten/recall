import { z } from "zod";
import { DEFAULT_PAGE_ROWS, fail, isInteger, MAX_QUERY_CHARS, type Parsed } from "./model";

export const artifactTypes = ["site", "document", "audio"] as const;
export type ArtifactType = (typeof artifactTypes)[number];

export const readPermissions = ["private", "account"] as const;
export type ReadPermission = (typeof readPermissions)[number];

export const writePermissions = ["owner", "account"] as const;
export type WritePermission = (typeof writePermissions)[number];

export interface ArtifactFile {
  path: string;
  bytes: number;
  contentType: string;
}

export interface ArtifactRecord {
  name: string;
  rev: number;
  type: ArtifactType;
  title: string;
  description: string;
  read: ReadPermission;
  write: WritePermission;
  entryPath: string;
  files: ArtifactFile[];
  fileCount: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
  lastWriter: string;
}

export interface ArtifactView {
  name: string;
  url: string;
  type: ArtifactType;
  title: string;
  description: string;
  read: ReadPermission;
  write: WritePermission;
  fileCount: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  lastWriter: string;
}

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_PATH_CHARS = 200;
export const MAX_PATH_SEGMENTS = 3;

export const ARTIFACT_CONTENT_TYPE = "text/html; charset=utf-8";

export const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"] as const;

export const DOCUMENT_EXTENSIONS = ["md", "markdown"] as const;

// What an extension answers as. The publish derives a file's content type from its path, so one
// artifact never answers two types for one byte stream and no caller names the header a reader
// gets back.
const CONTENT_TYPES: Record<string, string> = {
  html: ARTIFACT_CONTENT_TYPE,
  htm: ARTIFACT_CONTENT_TYPE,
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
};

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1);
};

export const contentTypeFor = (path: string): string => CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";

// The one place a revision is read. Revision 0 names the pre-container layout, where a one-file
// site's bytes sit at the bare key and nothing is ever written again; every revision from 1 on
// holds its files under a prefix of its own, which is what makes a publish atomic.
export const fileKey = (userId: string, name: string, rev: number, path: string): string =>
  rev === 0 ? `${userId}/${name}` : `${userId}/${name}/${rev}/${path}`;

export const artifactPrefix = (userId: string, name: string): string => `${userId}/${name}/`;

export const revisionPrefix = (userId: string, name: string, rev: number): string => `${userId}/${name}/${rev}/`;

const typeSchema = z.enum(artifactTypes);
const readSchema = z.enum(readPermissions);
const writeSchema = z.enum(writePermissions);
const titleSchema = z.string().max(MAX_TITLE_CHARS);
const descriptionSchema = z.string().max(MAX_DESCRIPTION_CHARS);

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

const pathSchema = z
  .string()
  .max(MAX_PATH_CHARS)
  .transform((path) => path.toLowerCase())
  .refine((path) => {
    const segments = path.split("/");
    return segments.length <= MAX_PATH_SEGMENTS && segments.every((segment) => SEGMENT.test(segment));
  });

// Each file's size is declared, because R2 takes a stream only where its length is known: the
// publish hands the part to storage as it arrives rather than buffering it, and a part that does
// not hold exactly what was declared is refused instead of stored short.
const manifestSchema = z.object({
  type: typeSchema,
  title: titleSchema,
  description: descriptionSchema,
  read: readSchema,
  write: writeSchema,
  files: z
    .array(z.object({ path: pathSchema, bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }))
    .min(1)
    .max(MAX_FILES),
});

export interface ArtifactMeta {
  title: string;
  description: string;
}

export interface ManifestFile {
  path: string;
  bytes: number;
}

export interface Manifest extends ArtifactMeta {
  type: ArtifactType;
  read: ReadPermission;
  write: WritePermission;
  files: ManifestFile[];
}

const TYPE_MESSAGE = `type must be one of ${artifactTypes.join(", ")}`;
const READ_MESSAGE = `read must be one of ${readPermissions.join(", ")}`;
const WRITE_MESSAGE = `write must be one of ${writePermissions.join(", ")}`;
const META_MESSAGE = `title must hold at most ${MAX_TITLE_CHARS} characters and description at most ${MAX_DESCRIPTION_CHARS}`;
const FILES_MESSAGE = `files must name 1 to ${MAX_FILES} files`;
const PATH_MESSAGE = `a file path holds at most ${MAX_PATH_SEGMENTS} segments of [a-z0-9][a-z0-9._-]* and at most ${MAX_PATH_CHARS} characters`;

export const parseArtifactType = (value: unknown): Parsed<ArtifactType> => {
  const parsed = typeSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : fail(TYPE_MESSAGE);
};

export const parseReadPermission = (value: unknown): Parsed<ReadPermission> => {
  const parsed = readSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : fail(READ_MESSAGE);
};

export const parseWritePermission = (value: unknown): Parsed<WritePermission> => {
  const parsed = writeSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : fail(WRITE_MESSAGE);
};

export const parseArtifactMeta = (title: unknown, description: unknown): Parsed<ArtifactMeta> => {
  const parsed = z.object({ title: titleSchema, description: descriptionSchema }).safeParse({ title, description });
  return parsed.success ? { ok: true, value: parsed.data } : fail(META_MESSAGE);
};

export const parseFilePath = (value: unknown): Parsed<string> => {
  const parsed = pathSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : fail(PATH_MESSAGE);
};

// Every track of an audio artifact plays in a browser's audio element, so the extensions are the
// ones it takes and the refusal names all seven rather than only the file that failed.
export const parseAudioFiles = (paths: readonly string[]): Parsed<string[]> => {
  for (const path of paths) {
    if (!(AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(path))) {
      return fail(`an audio artifact holds files ending ${AUDIO_EXTENSIONS.map((one) => `.${one}`).join(", ")}`);
    }
  }
  return { ok: true, value: [...paths] };
};

const MESSAGES: Record<string, string> = {
  type: TYPE_MESSAGE,
  read: READ_MESSAGE,
  write: WRITE_MESSAGE,
  title: META_MESSAGE,
  description: META_MESSAGE,
};

const manifestMessage = (error: z.ZodError): string => {
  const issue = error.issues[0];
  const field = String(issue?.path[0] ?? "");
  if (field === "files") return issue?.path.length === 1 ? FILES_MESSAGE : PATH_MESSAGE;
  return MESSAGES[field] ?? "the manifest must name type, title, description, read, write and files";
};

// The publish's first gate. A manifest that names a type, a permission, a title or a path the
// service does not take is refused here, before a byte of the body is read and before storage is
// touched at all.
export const parseManifest = (value: unknown): Parsed<Manifest> => {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) return fail(manifestMessage(parsed.error));
  const { type, title, description, read, write, files } = parsed.data;
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) return fail("files must name each path once");
  if (type === "audio") {
    const audio = parseAudioFiles(paths);
    if (!audio.ok) return audio;
  }
  const entry = paths[0] ?? "";
  if (type === "document" && !(DOCUMENT_EXTENSIONS as readonly string[]).includes(extensionOf(entry))) {
    return fail(`a document's first file ends ${DOCUMENT_EXTENSIONS.map((one) => `.${one}`).join(" or ")}`);
  }
  return { ok: true, value: { type, title, description, read, write, files } };
};

// What one page of the shelf is asked for. The sort arrives already folded onto one the list holds
// by the listing component, which owns the parameter and the keys.
export interface ArtifactListInput {
  query: string;
  type: ArtifactType | "";
  cursor: string;
  limit: number;
  sort: string;
}

export const parseArtifactList = (params: URLSearchParams, sort: string): Parsed<ArtifactListInput> => {
  const query = params.get("q") ?? "";
  if (query.length > MAX_QUERY_CHARS) return fail(`q must hold at most ${MAX_QUERY_CHARS} characters`);
  const asked = params.get("type") ?? "";
  const type = asked === "" ? ({ ok: true, value: "" } as const) : parseArtifactType(asked);
  if (!type.ok) return type;
  const limit = Number(params.get("limit") ?? DEFAULT_PAGE_ROWS);
  if (!isInteger(limit, 1, 100)) return fail("limit must be a whole number from 1 to 100");
  return { ok: true, value: { query, type: type.value, cursor: params.get("cursor") ?? "", limit, sort } };
};

export const readArtifactFile = (
  bucket: R2Bucket,
  userId: string,
  name: string,
  rev: number,
  path: string,
): Promise<R2ObjectBody | null> => bucket.get(fileKey(userId, name, rev, path));

export const headArtifactFile = (
  bucket: R2Bucket,
  userId: string,
  name: string,
  rev: number,
  path: string,
): Promise<R2Object | null> => bucket.head(fileKey(userId, name, rev, path));

export const putArtifactFile = async (
  bucket: R2Bucket,
  userId: string,
  name: string,
  rev: number,
  path: string,
  body: ReadableStream | ArrayBuffer,
): Promise<R2Object> => {
  const key = fileKey(userId, name, rev, path);
  const object = await bucket.put(key, body);
  if (object === null) throw new Error(`R2 stored no object at ${key}`);
  return object;
};

const deletePrefix = async (bucket: R2Bucket, prefix: string): Promise<void> => {
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    if (!page.truncated) return;
    cursor = page.cursor;
  }
};

// The revision a publish has just replaced. At revision 0 the bytes are the bare legacy key and
// there is no prefix to walk.
export const deleteRevision = async (bucket: R2Bucket, userId: string, name: string, rev: number): Promise<void> => {
  if (rev === 0) return bucket.delete(fileKey(userId, name, 0, ""));
  return deletePrefix(bucket, revisionPrefix(userId, name, rev));
};

// Everything one name holds: every revision under its prefix, and the legacy key beside it. One
// unpublish collects the dead revisions a failed cleanup left behind.
export const deleteArtifactFiles = async (bucket: R2Bucket, userId: string, name: string): Promise<void> => {
  await deletePrefix(bucket, artifactPrefix(userId, name));
  await bucket.delete(fileKey(userId, name, 0, ""));
};
