import { DEFAULT_PAGE_ROWS, fail, isInteger, isOneOf, isRecord, MAX_QUERY_CHARS, type Parsed } from "./model";

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
  // How many live shares the artifact holds, and zero where the deployment shares nothing, so the
  // row, the owner's bar and an agent reading a listing all say what is shared from one field and
  // none of them can change it.
  shareCount: number;
}

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 50;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_PATH_CHARS = 200;
export const MAX_PATH_SEGMENTS = 3;

// How much of a document's source the raw view inlines. The page escapes what it prints and
// concatenates it into one HTML string, so inlining a 32 MB file would hold three copies of it in
// UTF-16 at once; past this only the start is read and the page points at the file's own address,
// which streams the rest as text/markdown.
export const RAW_INLINE_BYTES = 128 * 1024;

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

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export interface ManifestFile {
  path: string;
  bytes: number;
}

export interface Manifest {
  type: ArtifactType;
  title: string;
  description: string;
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
const BYTES_MESSAGE = "each file must declare bytes as a whole number of zero or more";
const MANIFEST_MESSAGE = "the manifest must name type, title, description, read, write and files";

// A site is served inside `sandbox`, which gives it an opaque origin, so `'self'` matches nothing
// and a page can never load a second file of its own. The sandbox is what keeps one publisher's
// page away from another's, so the refusal names the two types that do hold several files.
const SITE_MESSAGE =
  "a site holds one file: it is served in a sandbox with an opaque origin and cannot load a second file of its own. Publish a document or an audio artifact to hold more than one file";

export const parseArtifactType = (value: unknown): Parsed<ArtifactType> =>
  isOneOf(artifactTypes, value) ? { ok: true, value } : fail(TYPE_MESSAGE);

export const parseFilePath = (value: unknown): Parsed<string> => {
  if (typeof value !== "string" || value.length > MAX_PATH_CHARS) return fail(PATH_MESSAGE);
  const path = value.toLowerCase();
  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS || !segments.every((segment) => SEGMENT.test(segment))) {
    return fail(PATH_MESSAGE);
  }
  return { ok: true, value: path };
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

// Each file's size is declared, because R2 takes a stream only where its length is known: the
// publish hands the part to storage as it arrives rather than buffering it, and a part that does
// not hold exactly what was declared is refused instead of stored short.
const parseManifestFiles = (value: unknown): Parsed<ManifestFile[]> => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) return fail(FILES_MESSAGE);
  const named: ManifestFile[] = [];
  for (const file of value) {
    if (!isRecord(file)) return fail(FILES_MESSAGE);
    const path = parseFilePath(file.path);
    if (!path.ok) return path;
    if (!isInteger(file.bytes, 0, Number.MAX_SAFE_INTEGER)) return fail(BYTES_MESSAGE);
    named.push({ path: path.value, bytes: file.bytes });
  }
  return { ok: true, value: named };
};

// The publish's first gate. A manifest that names a type, a permission, a title or a path the
// service does not take is refused here, before a byte of the body is read and before storage is
// touched at all.
export const parseManifest = (value: unknown): Parsed<Manifest> => {
  if (!isRecord(value)) return fail(MANIFEST_MESSAGE);
  const { type, title, description, read, write } = value;
  if (!isOneOf(artifactTypes, type)) return fail(TYPE_MESSAGE);
  if (typeof title !== "string" || title.length > MAX_TITLE_CHARS) return fail(META_MESSAGE);
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) return fail(META_MESSAGE);
  if (!isOneOf(readPermissions, read)) return fail(READ_MESSAGE);
  if (!isOneOf(writePermissions, write)) return fail(WRITE_MESSAGE);
  const parsed = parseManifestFiles(value.files);
  if (!parsed.ok) return parsed;
  const files = parsed.value;
  if (type === "site" && files.length > 1) return fail(SITE_MESSAGE);
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
