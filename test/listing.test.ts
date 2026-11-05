import { describe, expect, it } from "vitest";
import type { ArtifactView } from "../src/artifacts";
import { ARTIFACTS_TAB, type ArtifactTypeCount, artifactsPage, type Published } from "../src/dashboard";
import { ARTIFACT_SORTS, CURSOR_PARAM, type Listing, listingLink, SORT_PARAM, sortInForce } from "../src/listing";
import type { Live } from "../src/model";

const listing = (search: string): Listing => ({
  tab: ARTIFACTS_TAB,
  noun: { one: "artifact", many: "artifacts" },
  params: ["q", "type", SORT_PARAM, CURSOR_PARAM, "limit"],
  search: { param: "q", placeholder: "Search", ariaLabel: "Search", value: search, fields: [] },
  filters: [{ param: "type", ariaLabel: "Type", allLabel: "All", active: "", chips: [] }],
  sorts: ARTIFACT_SORTS,
  sort: "newest",
  unknownSort: "",
  rows: "<ol></ol>",
  empty: null,
  nextCursor: "",
  cut: false,
});

const at = (query: string): URL => new URL(`https://recall.test${ARTIFACTS_TAB.path}${query}`);

describe("the listing component's links", () => {
  it("keeps the other controls when one of them changes", () => {
    const url = at("?q=&type=document&sort=largest&limit=50");
    const list = listing("");
    expect(listingLink(list, url, { sort: "name" })).toBe(
      "/dashboard/artifacts?type=document&amp;sort=name&amp;limit=50",
    );
    expect(listingLink(list, url, { type: "audio" })).toBe(
      "/dashboard/artifacts?type=audio&amp;sort=largest&amp;limit=50",
    );
  });

  it("drops the cursor from every control, so a change restarts the walk at page one", () => {
    const url = at("?type=document&sort=largest&cursor=eyJhIjoxfQ");
    const list = listing("");
    expect(listingLink(list, url, { sort: "name" })).not.toContain("cursor");
    expect(listingLink(list, url, { type: "" })).toBe("/dashboard/artifacts?sort=largest");
  });

  it("sets the cursor on the page-end link and carries the narrowing into the next page", () => {
    const url = at("?type=document&sort=largest&cursor=first");
    expect(listingLink(listing(""), url, { cursor: "second" })).toBe(
      "/dashboard/artifacts?type=document&amp;sort=largest&amp;cursor=second",
    );
  });

  it("drops the sort while a search is set rather than carrying a value the page ignores", () => {
    const url = at("?q=panel&type=audio&sort=largest");
    const searching = listing("panel");
    expect(listingLink(searching, url, { type: "document" })).toBe("/dashboard/artifacts?q=panel&amp;type=document");
    expect(listingLink(listing(""), url, { type: "document" })).toContain("sort=largest");
  });

  it("never carries a parameter the list does not name", () => {
    const url = at("?type=document&tag=loud&since=1");
    expect(listingLink(listing(""), url, {})).toBe("/dashboard/artifacts?type=document");
  });

  it("clears a parameter a change empties", () => {
    const url = at("?q=panel&type=audio");
    expect(listingLink(listing("panel"), url, { q: "" })).toBe("/dashboard/artifacts?type=audio");
  });
});

describe("the artifacts tab's type chips", () => {
  const live: Live = { sessions: 0, busy: 0, sessionsToday: 0, today: [] };

  const site: ArtifactView = {
    name: "burn-up",
    url: "https://art.test/burn-up/",
    type: "site",
    title: "Burn-up",
    description: "",
    read: "private",
    write: "owner",
    fileCount: 1,
    bytes: 11,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastWriter: "alice@example.com",
  };

  const shelf = (artifacts: ArtifactView[], byType: ArtifactTypeCount[]): Published => ({
    kind: "shelf",
    shelf: { artifacts, counts: { total: 2, byType }, nextCursor: "", cut: false },
  });

  const page = (query: string, artifacts: ArtifactView[], byType: ArtifactTypeCount[]): Promise<string> =>
    artifactsPage("alice@example.com", live, at(query), shelf(artifacts, byType)).text();

  it("keeps the chip of the type in force once its count empties, so the filter can still be cleared", async () => {
    const drawn = await page("?type=audio", [], [{ type: "site", count: 2 }]);
    expect(drawn).toContain('<a href="/dashboard/artifacts?type=audio" aria-current="page">audio 0</a>');
    expect(drawn).toContain('<a href="/dashboard/artifacts">All 2</a>');
  });

  it("offers no chip for a type the shelf holds none of", async () => {
    const drawn = await page("", [site], [{ type: "site", count: 2 }]);
    expect(drawn).toContain(">site 2</a>");
    expect(drawn).not.toContain(">audio 0</a>");
  });
});

describe("the sort a listing reads out of its address", () => {
  it("takes the list's default when the address names none", () => {
    expect(sortInForce(at(""), ARTIFACT_SORTS)).toEqual({ sort: "newest", unknownSort: "" });
  });

  it("takes a sort the list holds", () => {
    expect(sortInForce(at("?sort=largest"), ARTIFACT_SORTS)).toEqual({ sort: "largest", unknownSort: "" });
  });

  it("falls back to the default and names the sort it could not serve", () => {
    expect(sortInForce(at("?sort=oldest"), ARTIFACT_SORTS)).toEqual({ sort: "newest", unknownSort: "oldest" });
  });

  it("names no sort at all for a list that offers none", () => {
    expect(sortInForce(at("?sort=oldest"), [])).toEqual({ sort: "", unknownSort: "" });
  });
});
