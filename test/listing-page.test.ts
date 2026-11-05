import { describe, expect, it } from "vitest";
import {
  parseArtifactList,
  parseArtifactMeta,
  parseArtifactType,
  parseAudioFiles,
  parseFilePath,
  parseManifest,
  parseReadPermission,
  parseWritePermission,
} from "../src/artifacts";
import { ARTIFACT_SORTS, HISTORY_SORTS, MEMORY_SORTS, sortInForce, sortKeys } from "../src/listing";
import { decodeCursor } from "../src/store";

const manifest = (over: Record<string, unknown> = {}): unknown => ({
  type: "site",
  title: "A title",
  description: "",
  read: "private",
  write: "owner",
  files: [{ path: "index.html", bytes: 11 }],
  ...over,
});

describe("the artifact parsers", () => {
  it("refuses a type the service does not take, naming the three it does", () => {
    expect(parseArtifactType("document")).toEqual({ ok: true, value: "document" });
    const refused = parseArtifactType("slideshow");
    expect(refused).toEqual({ ok: false, error: "type must be one of site, document, audio" });
  });

  it("refuses a permission outside the two each takes", () => {
    expect(parseReadPermission("account")).toEqual({ ok: true, value: "account" });
    expect(parseWritePermission("owner")).toEqual({ ok: true, value: "owner" });
    expect(parseReadPermission("world")).toEqual({ ok: false, error: "read must be one of private, account" });
    expect(parseWritePermission("anyone")).toEqual({ ok: false, error: "write must be one of owner, account" });
  });

  it("holds the title and the description to their limits", () => {
    expect(parseArtifactMeta("Title", "About it")).toEqual({
      ok: true,
      value: { title: "Title", description: "About it" },
    });
    expect(parseArtifactMeta("x".repeat(200), "y".repeat(500)).ok).toBe(true);
    expect(parseArtifactMeta("x".repeat(201), "").ok).toBe(false);
    expect(parseArtifactMeta("", "y".repeat(501)).ok).toBe(false);
    expect(parseArtifactMeta(42, "").ok).toBe(false);
  });

  it("case-folds a file path and refuses one that climbs out of the artifact", () => {
    expect(parseFilePath("Track-01.MP3")).toEqual({ ok: true, value: "track-01.mp3" });
    expect(parseFilePath("img/chart.png").ok).toBe(true);
    expect(parseFilePath("a/b/c/d.png").ok).toBe(false);
    expect(parseFilePath("../etc/passwd").ok).toBe(false);
    expect(parseFilePath("./x.png").ok).toBe(false);
    expect(parseFilePath("/absolute.png").ok).toBe(false);
    expect(parseFilePath(`${"x".repeat(201)}.png`).ok).toBe(false);
  });

  it("refuses a file an audio artifact cannot play, naming the seven it can", () => {
    expect(parseAudioFiles(["a.mp3", "b.flac"]).ok).toBe(true);
    const refused = parseAudioFiles(["a.mp3", "notes.txt"]);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain(".mp3, .m4a, .aac, .ogg, .opus, .wav, .flac");
  });

  it("reads a manifest and refuses the ones the service cannot store", () => {
    const parsed = parseManifest(manifest());
    expect(parsed).toEqual({
      ok: true,
      value: {
        type: "site",
        title: "A title",
        description: "",
        read: "private",
        write: "owner",
        files: [{ path: "index.html", bytes: 11 }],
      },
    });
    const one = (path: string): unknown[] => [{ path, bytes: 1 }];
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest(manifest({ files: [] })).ok).toBe(false);
    expect(
      parseManifest(manifest({ files: Array.from({ length: 51 }, (_one, at) => ({ path: `f${at}.png`, bytes: 1 })) }))
        .ok,
    ).toBe(false);
    expect(parseManifest(manifest({ files: [...one("a.png"), ...one("A.PNG")] })).ok).toBe(false);
    expect(parseManifest(manifest({ files: [{ path: "a.png" }] })).ok).toBe(false);
    expect(parseManifest(manifest({ files: [{ path: "a.png", bytes: -1 }] })).ok).toBe(false);
    expect(parseManifest(manifest({ type: "document", files: one("notes.txt") })).ok).toBe(false);
    expect(parseManifest(manifest({ type: "document", files: one("notes.md") })).ok).toBe(true);
    expect(parseManifest(manifest({ type: "audio", files: one("one.mp3") })).ok).toBe(true);
  });

  it("takes the listing's parameters and refuses a type it does not hold", () => {
    const params = new URLSearchParams("q=rollout&type=document&limit=5&cursor=abc");
    expect(parseArtifactList(params, "name")).toEqual({
      ok: true,
      value: { query: "rollout", type: "document", cursor: "abc", limit: 5, sort: "name" },
    });
    expect(parseArtifactList(new URLSearchParams(""), "newest")).toEqual({
      ok: true,
      value: { query: "", type: "", cursor: "", limit: 20, sort: "newest" },
    });
    expect(parseArtifactList(new URLSearchParams("type=slideshow"), "newest").ok).toBe(false);
    expect(parseArtifactList(new URLSearchParams("limit=0"), "newest").ok).toBe(false);
    expect(parseArtifactList(new URLSearchParams("limit=101"), "newest").ok).toBe(false);
  });
});

describe("the cursor", () => {
  it("reads the two-element shape the dashboard has always issued", () => {
    expect(decodeCursor(btoa(JSON.stringify([1_700_000_000_000, "abc"])), "desc")).toEqual([1_700_000_000_000, "abc"]);
  });

  it("carries a string where the order is a name", () => {
    expect(decodeCursor(btoa(JSON.stringify(["burn-up", "burn-up"])), "asc")).toEqual(["burn-up", "burn-up"]);
  });

  it("answers page one for the empty cursor, either way round", () => {
    expect(decodeCursor("", "desc")).toEqual([Number.MAX_SAFE_INTEGER, ""]);
    expect(decodeCursor("", "asc")).toEqual(["", ""]);
  });

  it("answers nothing for a cursor it cannot read", () => {
    expect(decodeCursor("not-base64-at-all!!", "desc")).toBeNull();
    expect(decodeCursor(btoa('{"at":1}'), "desc")).toBeNull();
    expect(decodeCursor(btoa("[true,1]"), "desc")).toBeNull();
  });
});

describe("the sorts each list holds", () => {
  it("names a key per sort, default first", () => {
    expect(sortKeys(ARTIFACT_SORTS)).toEqual(["newest", "name", "largest"]);
    expect(sortKeys(HISTORY_SORTS)).toEqual(["newest", "agent"]);
    expect(sortKeys(MEMORY_SORTS)).toEqual(["newest", "name", "recalled"]);
  });

  it("reads a sort it does not hold in the default order and says which it was", () => {
    const url = new URL("https://recall.test/dashboard/artifacts?sort=duration");
    expect(sortInForce(url, ARTIFACT_SORTS)).toEqual({ sort: "newest", unknownSort: "duration" });
    const held = new URL("https://recall.test/dashboard/artifacts?sort=largest");
    expect(sortInForce(held, ARTIFACT_SORTS)).toEqual({ sort: "largest", unknownSort: "" });
  });
});
