// bge-small-en-v1.5 accepts 512 tokens; 2000 chars is about that, and the Worker refuses longer queries
export const MAX_QUERY_CHARS = 2000;
export const MIN_SCORE = "0.55";

export function searchQuery(prompt) {
  return prompt.slice(0, MAX_QUERY_CHARS);
}
