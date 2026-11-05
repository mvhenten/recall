import type { Tab } from "./dashboard";

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

export const listingMain = (_url: URL, _listing: Listing): string => {
  throw new Error("listingMain has no renderer yet");
};

export const listingLink = (_listing: Listing, _url: URL, _changes: Record<string, string>): string => {
  throw new Error("listingLink has no renderer yet");
};
