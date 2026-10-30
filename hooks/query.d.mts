export declare const MAX_QUERY_CHARS: number;
export declare const MIN_SCORE: string;
export declare function searchQuery(prompt: string): string;
export declare function unseen<H extends { memory: { name: string } }, E extends { name: string }>(
  found: { hits: H[]; elsewhere: E[] },
  shown: Set<string>,
): { hits: H[]; elsewhere: E[] };
