// Returns shaped New-In product list for the order app.
// Source of truth:
//   - Catalog (title, images, pack, metafields) → Shopify Admin GraphQL
//   - Inventory (ATS = available-to-sell) → public/inventory.json (extracted daily from Style Master CSV)
//
// Why not Shopify inventory? FRP→Shopify sync only pushes bal_qty (on-hand) — preorder
// WIP-SO ATS is not reflected there. Style Master CSV is the truth source.
//
// Filters: 14-day publish window + has-image + has-ATS-per-color + F-suffix excluded + needs-model-shoot excluded.

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN || "edit-by-nine.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-10";
const INVENTORY_URL = process.env.INVENTORY_URL || "https://editbynine.netlify.app/inventory.json";

const QUERY = `
  query NewInProducts($query: String!) {
    products(first: 100, query: $query, sortKey: PUBLISHED_AT, reverse: true) {
      edges {
        node {
          id title handle tags publishedAt status
          priceRangeV2 { minVariantPrice { amount currencyCode } }
          featuredImage { url }
          images(first: 10) { edges { node { url } } }
          variants(first: 50) {
            edges {
              node {
                id title sku
                selectedOptions { name value }
                image { url }
              }
            }
          }
          metafields(first: 30, namespace: "custom") {
            edges { node { namespace key value } }
          }
        }
      }
    }
  }
`;

function parseMoney(jsonStr) {
  try { return JSON.parse(jsonStr); } catch { return null; }
}

// Normalize a SKU lookup key the same way FRP→Shopify sync builds variant SKUs.
// Style Master rows are "<style>-<color-stripped>" (uppercase, [A-Z0-9] only, max 8 chars).
function lookupKey(style, color) {
  const c = String(color || "").replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase() || "X";
  return `${String(style).toUpperCase()}-${c}`;
}

function shape(node, atsMap) {
  const mfMap = {};
  (node.metafields?.edges || []).forEach((e) => { if (e?.node) mfMap[e.node.key] = e.node.value; });

  const style = (mfMap.style_code || node.handle || node.title || "").toUpperCase().split(/[^A-Z0-9]/)[0];

  const packMoney = parseMoney(mfMap.pack_price);
  const unitMoney = parseMoney(mfMap.unit_price);
  const priceFloat = packMoney ? parseFloat(packMoney.amount) : parseFloat(node.priceRangeV2?.minVariantPrice?.amount || "0");
  const currency = packMoney?.currency_code || node.priceRangeV2?.minVariantPrice?.currencyCode || "USD";

  const prepack = mfMap.prepack_ratio || "";
  const packDisplay = prepack ? prepack.replace(/\s+/g, "").split(",").join(" / ") : "";
  let piecesPerPack = 1;
  if (mfMap.pack_size) piecesPerPack = parseInt(mfMap.pack_size, 10) || 1;
  else if (prepack) {
    piecesPerPack = prepack.split(",").reduce((sum, p) => {
      const n = parseInt((p.split(":")[1] || "").trim(), 10);
      return sum + (isNaN(n) ? 0 : n);
    }, 0) || 1;
  }

  let eta = "";
  if (mfMap.preorder_date) {
    const d = new Date(mfMap.preorder_date);
    eta = isNaN(d) ? mfMap.preorder_date : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  const productImgs = (node.images?.edges || []).map((e) => e.node.url);
  const featured = node.featuredImage?.url;

  // Filter variants by Style-Master ATS (truth source). Keep only colors with ATS > 0.
  const variants = (node.variants?.edges || []).map((e) => e.node);
  const colors = variants
    .map((v) => {
      const colorOpt = (v.selectedOptions || []).find((o) => /color/i.test(o.name));
      const colorName = colorOpt?.value || v.title || "";
      const ats = atsMap[lookupKey(style, colorName)] ?? 0;
      const imgs = [];
      if (v.image?.url) imgs.push(v.image.url);
      productImgs.forEach((u) => { if (!imgs.includes(u)) imgs.push(u); });
      return { name: colorName, ats, images: imgs.slice(0, 4) };
    })
    .filter((c) => c.ats > 0 && c.images.length > 0);

  return {
    id: style,
    name: node.title,
    price: priceFloat,
    currency,
    eta,
    pack: packDisplay,
    piecesPerPack,
    pricePerPiece: unitMoney ? parseFloat(unitMoney.amount) : (piecesPerPack ? priceFloat / piecesPerPack : priceFloat),
    colors,
  };
}

async function fetchInventoryMap() {
  try {
    const r = await fetch(INVENTORY_URL, { cache: "no-store" });
    if (!r.ok) return { ats: {}, error: `inventory.json ${r.status}` };
    const j = await r.json();
    return { ats: j.ats || {}, source: j.source, generatedAt: j.generatedAt };
  } catch (e) {
    return { ats: {}, error: e.message };
  }
}

exports.handler = async () => {
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300, s-maxage=300",
  };

  if (!TOKEN) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "SHOPIFY_ADMIN_TOKEN missing" }) };
  }

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const queryString = `status:active AND published_status:published AND published_at:>${cutoff} AND -tag:needs-model-shoot AND -tag:hidden`;

  try {
    const [shopRes, inv] = await Promise.all([
      fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
        body: JSON.stringify({ query: QUERY, variables: { query: queryString } }),
      }),
      fetchInventoryMap(),
    ]);
    const data = await shopRes.json();
    if (data.errors) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Shopify GraphQL error", detail: data.errors }) };
    }
    const edges = data?.data?.products?.edges || [];
    const products = edges
      .map((e) => shape(e.node, inv.ats))
      .filter((p) => p.id && !/F$/.test(p.id))
      .filter((p) => p.colors.length > 0);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        products,
        cutoff,
        inventorySource: inv.source,
        inventoryGeneratedAt: inv.generatedAt,
        inventoryError: inv.error,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
