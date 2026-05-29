// Extract style list from latest best-sellers CSV → public/best_sellers.json
// Run: node _extract_bestsellers.cjs
//
// Looks in Downloads/ for the most recent file matching:  best-sellers_*.csv

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const DOWNLOADS = "C:/Users/EDIT OFFICE/Downloads";
const OUT = path.join(__dirname, "public", "best_sellers.json");

const latest = fs.readdirSync(DOWNLOADS)
  .filter(f => /^best-sellers_.*\.csv$/i.test(f))
  .map(f => ({ f, m: fs.statSync(path.join(DOWNLOADS, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)[0];

if (!latest) {
  console.error("No best-sellers_*.csv found in", DOWNLOADS);
  process.exit(1);
}

const csvPath = path.join(DOWNLOADS, latest.f);
console.log("Source:", latest.f);

const rows = parse(fs.readFileSync(csvPath, "utf8"), {
  columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true,
});

const styles = [...new Set(
  rows.map(r => (r.Style || r.style || "").trim().toUpperCase()).filter(Boolean)
)].sort();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: latest.f,
  count: styles.length,
  styles,
}));
console.log(`Wrote ${OUT}  styles=${styles.length}`);
