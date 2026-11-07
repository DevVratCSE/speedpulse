import fs from "node:fs";

const d1Id = process.argv[2]?.trim();
const kvId = process.argv[3]?.trim();

if (!d1Id || !/^[a-f0-9-]{20,}$/i.test(d1Id)) {
  console.error("Usage: node scripts/set-db-id.mjs <D1_DATABASE_ID> [KV_NAMESPACE_ID]");
  process.exit(1);
}
const file = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.d1_databases[0].database_id = d1Id;
if (kvId && config.kv_namespaces && config.kv_namespaces[0]) {
  config.kv_namespaces[0].id = kvId;
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
console.log("Updated wrangler.jsonc with database and resource IDs.");
