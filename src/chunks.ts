// How what a session said is gathered into the pieces the index holds. What counts as a turn is
// read in turns.ts; this is only how those turns are cut up.
import { contentWords } from "./rank";
import type { Speaker, Turn } from "./turns";

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

// A chunk the turns ran out before closing. It is the chunker's working state and not a chunk: the
// pieces are kept apart rather than joined, because the next piece is weighed against the lengths
// of the ones already held and joining them would lose where they divided.
export interface OpenChunk {
  speaker: Speaker;
  pieces: string[];
  at: number;
}

// What one pass of the chunker produced: the chunks it closed, and the one still open per speaker.
// A caller with more turns coming carries the open ones into the next pass; one with none closes
// them itself.
export interface Chunked {
  closed: Chunk[];
  open: OpenChunk[];
}

const inOrder = (chunks: Chunk[]): Chunk[] =>
  chunks.sort((left, right) => left.at - right.at || left.speaker.localeCompare(right.speaker));

const closedOf = ({ speaker, pieces: held, at }: OpenChunk): Chunk => ({ speaker, text: held.join("\n\n"), at });

// The turns gathered into chunks, each speaker chunked on its own so a prompt is never indexed
// under the answer that followed it. A chunk closes when the next piece would push it past the
// ceiling, or when it already holds enough and the next piece shares too few of its words to be
// about the same thing.
//
// A chunk carried in opens that speaker's run where the last pass left it, which is what makes a
// boundary a function of the conversation rather than of how the turns arrived: the same turns fed
// in one pass and in thirty close in the same places. The words a carried chunk is weighed against
// are read back off its pieces, which is the set the pass that opened it had accumulated.
export const chunkTurnsCarrying = (turns: Turn[], carried: readonly OpenChunk[]): Chunked => {
  const closed: Chunk[] = [];
  const open: OpenChunk[] = [];
  for (const speaker of ["user", "model"] as const) {
    const carrying = carried.find((chunk) => chunk.speaker === speaker);
    let held: string[] = carrying === undefined ? [] : [...carrying.pieces];
    let words = new Set<string>();
    for (const part of held) for (const word of contentWords(part)) words.add(word);
    let at = carrying === undefined ? 0 : carrying.at;
    const close = (): void => {
      if (held.length > 0) closed.push({ speaker, text: held.join("\n\n"), at });
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
    if (held.length > 0) open.push({ speaker, pieces: held, at });
  }
  return { closed: inOrder(closed), open };
};

// The chunks a file was left holding, closed because no more records are coming. An open chunk
// waits for the turn that would have grown it, and a session that has ended has none: closing them
// is what makes its last words findable at all.
export const closeChunks = (open: readonly OpenChunk[]): Chunk[] => inOrder(open.map(closedOf));
