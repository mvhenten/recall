// bge-small-en-v1.5 accepts 512 tokens; 2000 chars is about that, and the Worker refuses longer queries
export const MAX_QUERY_CHARS = 2000;
export const MIN_SCORE = "0.65";

export function searchQuery(prompt) {
  return prompt.slice(0, MAX_QUERY_CHARS);
}

export function unseen({ hits, elsewhere }, shown) {
  return {
    hits: hits.filter(({ memory }) => !shown.has(memory.name)),
    elsewhere: elsewhere.filter(({ name }) => !shown.has(name)),
  };
}
