// Vercel function mirror of netlify/functions/products.js
// Returns shaped New-In product list for the order app.

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN || "edit-by-nine.myshopify.com";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2024-10";

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
                id title sku availableForSale
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

function shape(node) {
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

  const variants = (node.variants?.edges || []).map((e) => e.node).filter((v) => v.availableForSale);
  const colors = variants.map((v) => {
    const colorOpt = (v.selectedOptions || []).find((o) => /color/i.test(o.name));
    const name = colorOpt?.value || v.title || "";
    const imgs = [];
    if (v.image?.url) imgs.push(v.image.url);
    productImgs.forEach((u) => { if (!imgs.includes(u)) imgs.push(u); });
    return { name, images: imgs.slice(0, 4) };
  }).filter((c) => c.images.length > 0);

  return {
    id: style,
    name: node.title,
    price: priceFloat,
    currency,
    eta,
    pack: packDisplay,
    piecesPerPack,
    pricePerPiece: unitMoney ? parseFloat(unitMoney.amount) : (piecesPerPack ? priceFloat / piecesPerPack : priceFloat),
    colors: colors.length > 0 ? colors : (featured || productImgs[0] ? [{ name: "", images: featured ? [featured, ...productImgs].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4) : productImgs.slice(0, 4) }] : []),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!TOKEN) return res.status(500).json({ error: "SHOPIFY_ADMIN_TOKEN missing" });

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const queryString = `status:active AND published_status:published AND published_at:>${cutoff} AND -tag:needs-model-shoot AND -tag:hidden`;

  try {
    const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query: QUERY, variables: { query: queryString } }),
    });
    const data = await r.json();
    if (data.errors) return res.status(502).json({ error: "Shopify GraphQL error", detail: data.errors });
    const edges = data?.data?.products?.edges || [];
    const products = edges
      .map((e) => shape(e.node))
      .filter((p) => p.id && !/F$/.test(p.id))
      .filter((p) => p.colors.length > 0);
    res.status(200).json({ products, cutoff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
