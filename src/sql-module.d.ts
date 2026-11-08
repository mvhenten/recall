// A migration is a file of SQL, imported as the text it holds. Wrangler bundles it through its
// Text module rule and vitest through the loader beside its config.
declare module "*.sql" {
  const sql: string;
  export default sql;
}
