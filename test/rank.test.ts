import { describe, expect, it } from "vitest";
import { rankByScope, type Scored } from "../src/rank";

const candidates: Scored[] = [
  { memoryId: "far-best", score: 0.9 },
  { memoryId: "here-worst", score: 0.2 },
  { memoryId: "far-worst", score: 0.1 },
  { memoryId: "here-best", score: 0.8 },
];

describe("rankByScope", () => {
  it("sorts in scope above everything else, whatever the scores say", () => {
    const ranked = rankByScope(candidates, new Set(["here-best", "here-worst"]), 10);
    expect(ranked.map((hit) => hit.memoryId)).toEqual(["here-best", "here-worst", "far-best", "far-worst"]);
  });

  // The old shape cut twice and held three slots open for memories from elsewhere, so a caller
  // asking for two got up to five. One cut gives it two.
  it("cuts once, so a limit full of in-scope memories leaves no room for the rest", () => {
    const ranked = rankByScope(candidates, new Set(["here-best", "here-worst"]), 2);
    expect(ranked.map((hit) => hit.memoryId)).toEqual(["here-best", "here-worst"]);
  });

  it("lets a memory from elsewhere take the room the in-scope ones did not", () => {
    const ranked = rankByScope(candidates, new Set(["here-best"]), 2);
    expect(ranked.map((hit) => hit.memoryId)).toEqual(["here-best", "far-best"]);
  });

  it("ranks on score alone when nothing is in scope", () => {
    const ranked = rankByScope(candidates, new Set(), 4);
    expect(ranked.map((hit) => hit.memoryId)).toEqual(["far-best", "here-best", "here-worst", "far-worst"]);
  });

  it("settles a tie on the id, so one corpus answers one query one way", () => {
    const tied: Scored[] = [
      { memoryId: "b", score: 0.5 },
      { memoryId: "a", score: 0.5 },
    ];
    expect(rankByScope(tied, new Set(), 2).map((hit) => hit.memoryId)).toEqual(["a", "b"]);
  });
});
