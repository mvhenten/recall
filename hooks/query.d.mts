export declare const MAX_QUERY_CHARS: number;
export declare const MIN_SCORE: string;
export declare function searchQuery(prompt: string): string;
export declare function unseen<H extends { name: string }>(hits: H[], shown: Set<string>): H[];
