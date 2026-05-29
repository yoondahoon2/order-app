// Returns shaped New-In product list for the order app.
// Source of truth:
//   - Catalog (title, images, pack, metafields) → Shopify Admin GraphQL
//   - Inventory (ATS = available-to-sell) → public/inventory.json (extracted daily from Style Master CSV)
//
// Why not Shopify inventory? FRP→Shopify sync only pushes bal_qty (on-hand) — preorder
// WIP-SO ATS is not reflected there. Style Master CSV is the truth source.
//
// Filters: (14-day publish window OR best-seller style) + has-image + has-ATS≥18-per-color
//          + F-suffix excluded + needs-model-shoot excluded.

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN || "edit-by-nine.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-10";
const INVENTORY_URL = process.env.INVENTORY_URL || "https://editbynine.netlify.app/inventory.json";
const BESTSELLERS_URL = process.env.BESTSELLERS_URL || "https://editbynine.netlify.app/best_sellers.json";
const MIN_ATS = 18;

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

  // Decode Shopify CDN filename (spaces/parens encoded as _20_, _28_, _29_, etc.)
  // so we can match images to the correct color variant.
  const decodeFileName = (url) => {
    try {
      const file = url.split("/").pop().split("?")[0];
      return file
        .replace(/_([0-9a-fA-F]{2})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    } catch { return ""; }
  };
  const decodedImgs = productImgs.map((u) => ({ url: u, key: decodeFileName(u) }));

  // Filter variants by Style-Master ATS (truth source). Keep only colors with ATS > 0.
  const variants = (node.variants?.edges || []).map((e) => e.node);
  const colors = variants
    .map((v) => {
      const colorOpt = (v.selectedOptions || []).find((o) => /color/i.test(o.name));
      const colorName = colorOpt?.value || v.title || "";
      const ats = atsMap[lookupKey(style, colorName)] ?? 0;
      const colorSlug = colorName.toUpperCase().replace(/[^A-Z0-9]/g, "");

      // Match images that belong to THIS color only.
      // Filename pattern: <STYLE>_<COLOR>_<n>.jpg (e.g. TT8461_WHITE_(1).jpg → TT8461WHITE1)
      const matched = colorSlug
        ? decodedImgs.filter((d) => d.key.includes(`${style}${colorSlug}`)).map((d) => d.url)
        : [];

      // Detect product images that mention ANY color in the product (so we can tell
      // "color-specific" images from generic ones like CD8345_SIDE_PP.jpg).
      const allColorSlugs = variants
        .map((vv) => {
          const co = (vv.selectedOptions || []).find((o) => /color/i.test(o.name));
          return (co?.value || vv.title || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        })
        .filter(Boolean);
      const isColorTagged = (key) =>
        allColorSlugs.some((cs) => cs && key.includes(`${style}${cs}`));
      const genericImgs = decodedImgs.filter((d) => !isColorTagged(d.key)).map((d) => d.url);

      const imgs = [];
      // Prefer variant's own image — but only if it isn't tagged with a DIFFERENT color
      // (Shopify variant.image often points to the wrong color when not manually set.)
      if (v.image?.url) {
        const vKey = decodeFileName(v.image.url);
        const mentionsOtherColor = allColorSlugs.some(
          (cs) => cs && cs !== colorSlug && vKey.includes(`${style}${cs}`)
        );
        if (!mentionsOtherColor) imgs.push(v.image.url);
      }
      // Then any product images whose filename matches this color
      matched.forEach((u) => { if (!imgs.includes(u)) imgs.push(u); });
      // If no color-specific matches existed at all, fall back to generic (uncolored) imgs
      if (matched.length === 0) {
        genericImgs.forEach((u) => { if (!imgs.includes(u)) imgs.push(u); });
      }
      // Final fallback to featuredImage (only if it's not tagged with another color)
      if (imgs.length === 0 && featured) {
        const fKey = decodeFileName(featured);
        const featuredOther = allColorSlugs.some(
          (cs) => cs && cs !== colorSlug && fKey.includes(`${style}${cs}`)
        );
        if (!featuredOther) imgs.push(featured);
      }

      return { name: colorName, ats, images: imgs.slice(0, 4) };
    })
    .filter((c) => c.ats >= MIN_ATS && c.images.length > 0);

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

async function fetchBestsellers() {
  try {
    const r = await fetch(BESTSELLERS_URL, { cache: "no-store" });
    if (!r.ok) return { styles: [], error: `best_sellers.json ${r.status}` };
    const j = await r.json();
    return { styles: j.styles || [], source: j.source, generatedAt: j.generatedAt };
  } catch (e) {
    return { styles: [], error: e.message };
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
  const baseFilter = `status:active AND published_status:published AND -tag:needs-model-shoot AND -tag:hidden`;
  const newInQuery = `${baseFilter} AND published_at:>${cutoff}`;

  const gqlFetch = (queryString) =>
    fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query: QUERY, variables: { query: queryString } }),
    }).then((r) => r.json());

  try {
    const [newInData, inv, bs] = await Promise.all([
      gqlFetch(newInQuery),
      fetchInventoryMap(),
      fetchBestsellers(),
    ]);

    if (newInData.errors) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Shopify GraphQL error", detail: newInData.errors }) };
    }

    // Best-sellers: query by variant SKU prefix (style is in SKU, not handle). Chunked OR query.
    const bsStyles = (bs.styles || []).map((s) => s.toUpperCase());
    const chunks = [];
    for (let i = 0; i < bsStyles.length; i += 10) chunks.push(bsStyles.slice(i, i + 10));
    const bsResults = await Promise.all(
      chunks.map((chunk) => {
        const ors = chunk.map((s) => `sku:${s}*`).join(" OR ");
        return gqlFetch(`${baseFilter} AND (${ors})`);
      })
    );

    const allEdges = [...(newInData?.data?.products?.edges || [])];
    for (const r of bsResults) {
      if (r.errors) continue;
      allEdges.push(...(r?.data?.products?.edges || []));
    }

    // Dedupe by node.id
    const seen = new Set();
    const uniq = [];
    for (const e of allEdges) {
      const id = e?.node?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      uniq.push(e);
    }

    const products = uniq
      .map((e) => shape(e.node, inv.ats))
      .filter((p) => p.id && !/F$/.test(p.id))
      .filter((p) => p.colors.length > 0);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        products,
        cutoff,
        minAts: MIN_ATS,
        inventorySource: inv.source,
        inventoryGeneratedAt: inv.generatedAt,
        inventoryError: inv.error,
        bestsellersSource: bs.source,
        bestsellersGeneratedAt: bs.generatedAt,
        bestsellersError: bs.error,
        bestsellersCount: bsStyles.length,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
