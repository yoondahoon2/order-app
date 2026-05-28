// Extract ATS inventory from latest Style Master CSV → public/inventory.json
// Run from order-app dir: node _extract_inventory.cjs
//
// Output shape:
// {
//   "generatedAt": "2026-05-28T...",
//   "source": "Style Master_05282026.csv",
//   "ats": { "YT8845-IVORY": 120, "YT8593-LTTAUPE": 96, ... }
// }
//
// Key columns (1-indexed in header):
//   1  style
//   2  color
//   3  status         (ACTIVE = include)
//   130 atsqty        ← truth
//
// SKU normalization matches FRP→Shopify sync (server/routes/v2/shopify.ts):
//   sku = `${style}-${color.replace(/[^A-Z0-9]/gi, "").slice(0,8) || "X"}`

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const DOWNLOADS = "C:/Users/EDIT OFFICE/Downloads";
const OUT = path.join(__dirname, "public", "inventory.json");

// Find latest Style Master_*.csv (by mtime)
const latest = fs.readdirSync(DOWNLOADS)
  .filter(f => /^Style Master_\d+\.csv$/i.test(f))
  .map(f => ({ f, m: fs.statSync(path.join(DOWNLOADS, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];

if (!latest) {
  console.error("No Style Master_*.csv found in", DOWNLOADS);
  process.exit(1);
}

const csvPath = path.join(DOWNLOADS, latest.f);
console.log("Source:", latest.f);

const raw = fs.readFileSync(csvPath, "utf8");
const rows = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });

const ats = {};
let kept = 0, skipped = 0;
for (const r of rows) {
  const style = (r.style || "").trim().toUpperCase();
  const color = (r.color || "").trim();
  const status = (r.status || "").trim().toUpperCase();
  const qty = parseFloat(r.atsqty || "0");

  if (!style) { skipped++; continue; }
  if (status !== "ACTIVE") { skipped++; continue; }
  if (!(qty > 0)) { skipped++; continue; }

  // Match FRP→Shopify SKU rule
  const sku = `${style}-${color.replace(/[^A-Z0-9]/gi, "").slice(0, 8) || "X"}`.toUpperCase();
  ats[sku] = Math.floor(qty);
  kept++;
}

const out = {
  generatedAt: new Date().toISOString(),
  source: latest.f,
  count: kept,
  ats,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT}  kept=${kept}  skipped=${skipped}`);
