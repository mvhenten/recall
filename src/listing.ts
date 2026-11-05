import type { Tab } from "./dashboard";
import { escapeHtml } from "./page";

// The parameter names the component owns. A list names its own search, filter and field
// parameters; these two are the component's, so paging and ordering ride the same name on every
// list and a reader who learns one address has learnt them all.
export const SORT_PARAM = "sort";
export const CURSOR_PARAM = "cursor";

// A relevance order is a float with ties, so a keyset cursor cannot walk it: a search answers one
// bounded page and the component says so when the match set was cut to this.
export const MAX_SEARCH_MATCHES = 50;

export interface ListingSort {
  key: string;
  label: string;
}

export interface ListingChip {
  value: string;
  label: string;
}

export interface ListingFilter {
  param: string;
  ariaLabel: string;
  allLabel: string;
  active: string;
  chips: ListingChip[];
}

export interface ListingField {
  param: string;
  placeholder: string;
  ariaLabel: string;
  value: string;
}

export interface ListingSearch {
  param: string;
  placeholder: string;
  ariaLabel: string;
  value: string;
  fields: ListingField[];
}

export interface Listing {
  tab: Tab;
  noun: { one: string; many: string };
  params: readonly string[];
  search: ListingSearch | null;
  filters: ListingFilter[];
  sorts: ListingSort[];
  sort: string;
  unknownSort: string;
  rows: string;
  empty: { headline: string; hint: string } | null;
  nextCursor: string;
  cut: boolean;
}

// The sorts each list offers, in default-first order. They live here because the renderer prints
// the labels and the page reader picks its index off the key, and the two cannot be allowed to
// disagree about what a key is called.
export const ARTIFACT_SORTS: ListingSort[] = [
  { key: "newest", label: "newest first" },
  { key: "name", label: "name A to Z" },
  { key: "largest", label: "largest first" },
];

export const HISTORY_SORTS: ListingSort[] = [
  { key: "newest", label: "newest first" },
  { key: "agent", label: "agent name" },
];

export const MEMORY_SORTS: ListingSort[] = [
  { key: "newest", label: "newest first" },
  { key: "name", label: "name A to Z" },
  { key: "recalled", label: "most recalled" },
];

export const sortKeys = (sorts: readonly ListingSort[]): string[] => sorts.map((sort) => sort.key);

// A sort the list does not hold reads in the default order and says so, rather than answering an
// error page: a bookmark built when the list had another sort still loads the list.
export const sortInForce = (url: URL, sorts: readonly ListingSort[]): { sort: string; unknownSort: string } => {
  const first = sorts[0];
  if (!first) return { sort: "", unknownSort: "" };
  const asked = url.searchParams.get(SORT_PARAM) ?? "";
  if (asked === "") return { sort: first.key, unknownSort: "" };
  if (sorts.some((sort) => sort.key === asked)) return { sort: asked, unknownSort: "" };
  return { sort: first.key, unknownSort: asked };
};

const tabLink = (tab: Tab, keep: readonly string[], url: URL, changes: Record<string, string>): string => {
  const next = new URLSearchParams();
  for (const name of keep) {
    const value = url.searchParams.get(name) ?? "";
    if (value !== "") next.set(name, value);
  }
  for (const [name, value] of Object.entries(changes)) {
    if (value === "") next.delete(name);
    else next.set(name, value);
  }
  const query = next.toString();
  return escapeHtml(query === "" ? tab.path : `${tab.path}?${query}`);
};

export const emptyState = (headline: string, hint: string): string =>
  `<div class="empty"><b>${escapeHtml(headline)}</b><p>${escapeHtml(hint)}</p></div>`;

const searching = (listing: Listing): boolean => listing.search !== null && listing.search.value !== "";

// Every link rebuilds the query from the current one, so a filter, a search and a sort that are
// all set survive a change to any one of them. Two are dropped: the cursor, because a cursor cut
// from one order means nothing in another, and the sort while a search is set, because the address
// has to say what the page is doing rather than carry a value the page ignores.
export const listingLink = (listing: Listing, url: URL, changes: Record<string, string>): string => {
  const held = searching(listing);
  const keep = listing.params.filter((param) => param !== CURSOR_PARAM && !(param === SORT_PARAM && held));
  return tabLink(listing.tab, keep, url, changes);
};

const listed = (labels: string[]): string => {
  const last = labels[labels.length - 1] ?? "";
  if (labels.length < 2) return last;
  return `${labels.slice(0, -1).join(", ")} and ${last}`;
};

const unknownSortCallout = (listing: Listing): string => {
  const first = listing.sorts[0];
  if (!first) return "";
  const rest = listing.sorts.slice(1).map((sort) => sort.label);
  const also = rest.length === 0 ? "" : `, and it also sorts by ${listed(rest)}`;
  return `<p class="callout">${escapeHtml(
    `This list has no sort named “${listing.unknownSort}”, so the rows read in its default order of ${first.label}${also}.`,
  )}</p>`;
};

const cutCallout = (listing: Listing): string =>
  `<p class="callout">${escapeHtml(
    `A search answers at most ${MAX_SEARCH_MATCHES} ${listing.noun.many} and this one matched more. Add a word to narrow it.`,
  )}</p>`;

const textInput = (type: string, param: string, value: string, placeholder: string, ariaLabel: string): string =>
  `<input${type === "" ? "" : ` type="${type}"`} name="${escapeHtml(param)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(ariaLabel)}">`;

// The form carries every other parameter the list rides as a hidden field, so submitting a search
// keeps the filters a reader already set. The cursor and the sort are not among them: a search is
// one page and it replaces the order.
const searchForm = (listing: Listing, url: URL, search: ListingSearch): string => {
  const own = new Set<string>([CURSOR_PARAM, SORT_PARAM, search.param, ...search.fields.map((one) => one.param)]);
  const hidden = listing.params
    .filter((param) => !own.has(param))
    .map((param) => ({ param, value: url.searchParams.get(param) ?? "" }))
    .filter((carried) => carried.value !== "")
    .map((carried) => `<input type="hidden" name="${escapeHtml(carried.param)}" value="${escapeHtml(carried.value)}">`)
    .join("");
  const fields = search.fields
    .map((one) => textInput("", one.param, one.value, one.placeholder, one.ariaLabel))
    .join("");
  return `<form class="find" method="get" action="${escapeHtml(listing.tab.path)}">
${textInput("search", search.param, search.value, search.placeholder, search.ariaLabel)}
${fields}${hidden}<button type="submit">Search</button></form>`;
};

const chipGroup = (listing: Listing, url: URL, filter: ListingFilter): string => {
  const chip = (value: string, label: string): string =>
    `<a href="${listingLink(listing, url, { [filter.param]: value })}"${
      value === filter.active ? ' aria-current="page"' : ""
    }>${escapeHtml(label)}</a>`;
  return `<nav class="chips" aria-label="${escapeHtml(filter.ariaLabel)}">${chip("", filter.allLabel)}${filter.chips
    .map((one) => chip(one.value, one.label))
    .join("")}</nav>`;
};

// A row of links, square and bordered beside the round filter chips, because a filter narrows the
// set and a sort reorders it and the two share one row. While a search is set no sort applies, so
// each option is drawn as a span: it keeps its place, loses its focus, and the order in force is
// named beside it rather than left for the reader to work out.
const sortControl = (listing: Listing, url: URL): string => {
  if (listing.sorts.length === 0) return "";
  if (searching(listing)) {
    return `<nav class="sorts inert" aria-label="Sort">${listing.sorts
      .map((sort) => `<span>${escapeHtml(sort.label)}</span>`)
      .join("")}</nav><p class="sortwhy">Relevance order, while a search is set.</p>`;
  }
  return `<nav class="sorts" aria-label="Sort">${listing.sorts
    .map(
      (sort) =>
        `<a href="${listingLink(listing, url, { [SORT_PARAM]: sort.key })}"${
          sort.key === listing.sort ? ' aria-current="page"' : ""
        }>${escapeHtml(sort.label)}</a>`,
    )
    .join("")}</nav>`;
};

const toolrow = (listing: Listing, url: URL): string => {
  const parts = [
    listing.search === null ? "" : searchForm(listing, url, listing.search),
    ...listing.filters.map((filter) => chipGroup(listing, url, filter)),
    sortControl(listing, url),
  ].join("");
  return parts === "" ? "" : `<div class="toolrow">${parts}</div>`;
};

const narrowed = (listing: Listing): boolean =>
  searching(listing) || listing.unknownSort !== "" || listing.filters.some((filter) => filter.active !== "");

const body = (listing: Listing): string => {
  if (listing.rows !== "") return listing.rows;
  if (listing.empty === null) return "";
  return emptyState(listing.empty.headline, listing.empty.hint);
};

export const listingMain = (url: URL, listing: Listing): string => {
  const head = listing.unknownSort === "" ? "" : unknownSortCallout(listing);
  // A list holding nothing at all, with nothing set, draws its empty state and no controls: there
  // is nothing to narrow, and a row of controls over an empty page reads as a fault.
  const controls = listing.rows === "" && !narrowed(listing) ? "" : toolrow(listing, url);
  const cut = listing.cut ? cutCallout(listing) : "";
  const more =
    listing.nextCursor === ""
      ? ""
      : `<p class="more"><a href="${listingLink(listing, url, { [CURSOR_PARAM]: listing.nextCursor })}">Older ${escapeHtml(listing.noun.many)}</a></p>`;
  return `${head}${controls}${body(listing)}${cut}${more}`;
};
