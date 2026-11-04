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
