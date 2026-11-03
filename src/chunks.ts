// What a session said, read out of the transcript it archived. A transcript is mostly machinery —
// tool calls, tool results, file snapshots, hook output — and indexing that is indexing noise, so
// only two things are taken from it: the prompts the user typed and the prose the model answered
// with. Delegated turns live in files of their own and are never read here.
//
// `typed` mirrors the reader of the same name in cli/src/adopt.rs, which is the original: a host
// adopting a running session and this service reading the same transcript back must agree on what
// a prompt is, or a session's focus line and its index would disagree about what it was about.
import { contentWords } from "./rank";

export type Speaker = "user" | "model";

export interface Turn {
  speaker: Speaker;
  text: string;
  at: number;
}

export interface Chunk {
  speaker: Speaker;
  text: string;
  /// When the stretch of conversation this chunk holds began.
  at: number;
}

// A chunk holds enough prose to mean something on its own and little enough to still be about one
// thing. A turn longer than the ceiling is cut on its own paragraph breaks.
export const MIN_CHUNK_CHARS = 400;
export const MAX_CHUNK_CHARS = 2_000;

// How much of its words a turn must share with the chunk so far to belong to it. Below this the
// conversation has moved on, and the chunk closes where the subject changed rather than where the
// character budget ran out. A chunk short of the floor is never split this way: two prompts in a
// row rarely repeat each other's words, and splitting on that alone would make every prompt a
// chunk of its own and leave the index a heap of one-liners.
const SHARED_WORDS = 0.12;

const ENVELOPES = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<task-notification>",
];

interface Entry {
  type?: unknown;
  message?: { content?: unknown };
  timestamp?: unknown;
  origin?: { kind?: unknown };
  toolUseResult?: unknown;
  interruptedMessageId?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isVisibleInTranscriptOnly?: unknown;
  isCompactSummary?: unknown;
  agentName?: unknown;
  customTitle?: unknown;
}

const parse = (line: string): Entry | null => {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null ? (entry as Entry) : null;
  } catch {
    return null;
  }
};

const spoken = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
};

// What the user typed, for an entry that is a prompt they typed. Claude Code writes several kinds
// of entry as a user turn — a tool result, a task notification, the expansion of a slash command,
// the summary a compaction leaves behind — and none of those is a prompt. A current transcript
// says which is which outright in `origin.kind`; an older one carries no origin and is read off
// the marks it does have.
const typed = (entry: Entry): string => {
  if (entry.toolUseResult != null || entry.interruptedMessageId != null) return "";
  if (entry.isMeta === true || entry.isVisibleInTranscriptOnly === true || entry.isCompactSummary === true) return "";
  const prompt = spoken(entry.message?.content).trim();
  if (prompt === "") return "";
  const kind = entry.origin?.kind;
  if (typeof kind === "string") return kind === "human" ? prompt : "";
  return ENVELOPES.some((envelope) => prompt.startsWith(envelope)) ? "" : prompt;
};

const stamp = (entry: Entry): number => {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

// The name the harness gives a session, which `agent-name` carries and `custom-title` carried
// before it. Both sit among the first entries of a transcript, so a caller holding a session's
// head has the name without reading the rest.
export const agentName = (head: string): string => {
  for (const line of head.split("\n")) {
    const entry = parse(line);
    if (entry === null) continue;
    const named =
      entry.type === "agent-name" ? entry.agentName : entry.type === "custom-title" ? entry.customTitle : "";
    if (typeof named === "string" && named !== "") return named;
  }
  return "";
};

// Every turn in one stretch of a transcript, in the order it was written. A line that does not
// parse is skipped, which is also what a stretch cut mid-entry leaves behind; a delegated turn
// inside the session's own file is skipped outright, since it is the model talking to itself.
export const readTurns = (stretch: string): Turn[] => {
  const turns: Turn[] = [];
  for (const line of stretch.split("\n")) {
    const entry = parse(line);
    if (entry === null || entry.isSidechain === true) continue;
    if (entry.type === "user") {
      const prompt = typed(entry);
      if (prompt !== "") turns.push({ speaker: "user", text: prompt, at: stamp(entry) });
      continue;
    }
    if (entry.type !== "assistant") continue;
    const said = spoken(entry.message?.content).trim();
    if (said !== "") turns.push({ speaker: "model", text: said, at: stamp(entry) });
  }
  return turns;
};

const sharedWith = (words: Set<string>, next: Set<string>): number => {
  if (words.size === 0 || next.size === 0) return 1;
  let common = 0;
  for (const word of next) if (words.has(word)) common += 1;
  return common / next.size;
};

// A turn past the ceiling, cut on its own paragraph breaks and then, for a paragraph that is
// itself too long, on the ceiling.
const pieces = (text: string): string[] => {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const cut: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    for (let rest = paragraph; rest !== ""; rest = rest.slice(MAX_CHUNK_CHARS)) {
      const part = rest.slice(0, MAX_CHUNK_CHARS).trim();
      if (part !== "") cut.push(part);
    }
  }
  return cut;
};

// The turns gathered into chunks, each speaker chunked on its own so a prompt is never indexed
// under the answer that followed it. A chunk closes when the next piece would push it past the
// ceiling, or when it already holds enough and the next piece shares too few of its words to be
// about the same thing.
export const chunkTurns = (turns: Turn[]): Chunk[] => {
  const chunks: Chunk[] = [];
  for (const speaker of ["user", "model"] as const) {
    let held: string[] = [];
    let words = new Set<string>();
    let at = 0;
    const close = (): void => {
      if (held.length > 0) chunks.push({ speaker, text: held.join("\n\n"), at });
      held = [];
      words = new Set();
    };
    for (const turn of turns.filter((turn) => turn.speaker === speaker)) {
      for (const piece of pieces(turn.text)) {
        const length = held.reduce((all, part) => all + part.length + 2, 0);
        const next = contentWords(piece);
        const moved = length >= MIN_CHUNK_CHARS && sharedWith(words, next) < SHARED_WORDS;
        if (held.length > 0 && (length + piece.length > MAX_CHUNK_CHARS || moved)) close();
        if (held.length === 0) at = turn.at;
        held.push(piece);
        for (const word of next) words.add(word);
      }
    }
    close();
  }
  return chunks.sort((left, right) => left.at - right.at || left.speaker.localeCompare(right.speaker));
};
