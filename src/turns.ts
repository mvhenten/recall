// What a session said, read out of the transcript it archived. A transcript is mostly machinery —
// tool calls, tool results, file snapshots, hook output — and reading that is reading noise, so
// only two things are taken from it: the prompts the user typed and the prose the model answered
// with. Delegated turns live in files of their own and are never read here.
//
// `typed` mirrors the reader of the same name in cli/src/adopt.rs, which is the original: a host
// adopting a running session and this service reading the same transcript back must agree on what
// a prompt is, or a session's focus line and its index would disagree about what it was about.
// The dashboard runs this very module in the browser — npm-scripts/build-browser.mjs bundles it
// into the session page's script — so what the page shows and what the index holds cannot drift.
// Nothing here may reach for a stopword list, a database or a binding for that reason.

export type Speaker = "user" | "model";

export interface Turn {
  speaker: Speaker;
  text: string;
  at: number;
}

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

// The name a session's own transcript is held under; mirrors MAIN_FILE in transcripts.ts, which
// this module cannot import without pulling the archive into the browser bundle. Every other name
// is a file of delegated turns, which the harness writes one of per subagent.
const OWN_FILE = "main";

// Every turn in one stretch of one file of a transcript, in the order it was written. A line that
// does not parse is skipped, which is also what a stretch cut mid-entry leaves behind.
//
// A delegated turn inside the session's own file is skipped outright, since it is the model
// talking to itself. The harness marks every entry of a delegated file a sidechain too, so the
// same skip read one of those as a file with no turn in it at all; a file that is nothing but
// delegated turns is read for the prose it holds instead.
export const readTurns = (stretch: string, file: string): Turn[] => {
  const own = file === OWN_FILE;
  const turns: Turn[] = [];
  for (const line of stretch.split("\n")) {
    const entry = parse(line);
    if (entry === null) continue;
    if (own && entry.isSidechain === true) continue;
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
