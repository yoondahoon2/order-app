import React, { useMemo, useState, useEffect } from "react";

export default function App() {
  const [products, setProducts] = useState([]);
  const [query, setQuery] = useState("");
  const [selectedColors, setSelectedColors] = useState({});
  const [lightbox, setLightbox] = useState(null); // { productId, imgIdx }

  const [cart, setCart] = useState(() => {
    try {
      const saved = localStorage.getItem("cart");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    async function loadProducts() {
      try {
        const TOKEN = import.meta.env.VITE_MAGENTO_TOKEN;
        const BASE = "https://www.editbynine.com/media/catalog/product";
        const headers = { "Authorization": `Bearer ${TOKEN}` };

        // 1. GraphQL: new-in 카테고리 상품 (이름/가격/재고)
        const gqlRes = await fetch(`/graphql`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query {
              categoryList(filters: { url_key: { eq: "new-in" } }) {
                products(pageSize: 100) {
                  items {
                    sku name stock_status
                    price_range {
                      minimum_price { regular_price { value currency } }
                    }
                  }
                }
              }
            }`,
          }),
        });
        const gqlData = await gqlRes.json();
        const groupedItems = gqlData?.data?.categoryList?.[0]?.products?.items || [];

        // 2. REST: 그룹 상품 일괄 조회 (product_links + custom_attributes)
        const groupedSkuValue = groupedItems.map((p) => p.sku).join(",");
        const groupedRestRes = await fetch(
          `/rest/V1/products?searchCriteria[pageSize]=100&searchCriteria[filterGroups][0][filters][0][field]=sku&searchCriteria[filterGroups][0][filters][0][value]=${groupedSkuValue}&searchCriteria[filterGroups][0][filters][0][conditionType]=in`,
          { headers }
        );
        const groupedRestData = await groupedRestRes.json();
        const groupedRestItems = groupedRestData?.items || [];

        // custom_attributes 확인용 로그 (첫 번째 상품)
        if (groupedRestItems[0]) {
          const attrMap = {};
          groupedRestItems[0].custom_attributes?.forEach(a => { attrMap[a.attribute_code] = a.value; });
          // console.log("Full attribute map:", JSON.stringify(attrMap));
        }

        // grouped product 맵 (SKU → REST data)
        const groupedRestMap = {};
        groupedRestItems.forEach((p) => { groupedRestMap[p.sku] = p; });

        // product_links 맵
        const linksMap = {};
        groupedRestItems.forEach((p) => {
          linksMap[p.sku] = (p.product_links || [])
            .filter((l) => l.link_type === "associated")
            .map((l) => l.linked_product_sku);
        });

        // 3. REST: linked simple 상품 일괄 조회 (이미지)
        const allLinkedSkus = [...new Set(Object.values(linksMap).flat())];
        const skuValue = allLinkedSkus.join(",");
        const simpleRes = await fetch(
          `/rest/V1/products?searchCriteria[pageSize]=500&searchCriteria[filterGroups][0][filters][0][field]=sku&searchCriteria[filterGroups][0][filters][0][value]=${skuValue}&searchCriteria[filterGroups][0][filters][0][conditionType]=in`,
          { headers }
        );
        const simpleData = await simpleRes.json();
        const simpleProducts = simpleData?.items || [];

        // SKU → { images[] } 맵
        const simpleMap = {};
        simpleProducts.forEach((p) => {
          const images = (p.media_gallery_entries || [])
            .filter((e) => !e.disabled && e.file && !e.file.includes("placeholder"))
            .slice(0, 4)
            .map((e) => `${BASE}${e.file}`);
          simpleMap[p.sku] = images;
        });

        // 4. 최종 상품 데이터 조합
        const mapped = groupedItems
          .filter((p) => p.stock_status === "IN_STOCK")
          .map((p) => {
            const restData = groupedRestMap[p.sku];
            const attrs = restData?.custom_attributes || [];
            const attr = (code) => attrs.find((a) => a.attribute_code === code)?.value || "";

            const linkedSkus = linksMap[p.sku] || [];
            const colors = linkedSkus
              .map((sku) => ({
                name: sku.startsWith(p.sku + "-") ? sku.slice(p.sku.length + 1) : sku,
                images: simpleMap[sku] || [],
              }))
              .filter((c) => c.images.length > 0);

            return {
              id: p.sku,
              name: p.name,
              price: p.price_range?.minimum_price?.regular_price?.value ?? 0,
              currency: p.price_range?.minimum_price?.regular_price?.currency ?? "USD",
              eta: (() => {
                const d = attr("preorder_date");
                if (!d) return "";
                const date = new Date(d);
                return isNaN(date) ? d : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
              })(),
              pack: (() => {
                const sizes = attr("prepack_code"); // "S,M,L"
                const ratios = attr("prepack");     // "3,2,1"
                if (!ratios) return "";
                if (sizes) {
                  const s = sizes.split(",");
                  const r = ratios.split(",");
                  return s.map((sz, i) => `${sz.trim()}:${r[i]?.trim() || ""}`).join(" / ");
                }
                return ratios.replace(/,/g, "-");
              })(),
              colors,
            };
          });

        setProducts(mapped);
      } catch (err) {
        console.error("Magento load error:", err);
      }
    }
    loadProducts();
  }, []);

  useEffect(() => {
    localStorage.setItem("cart", JSON.stringify(cart));
  }, [cart]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return products.filter(
      (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
  }, [products, query]);

  // cart key = "SKU|||colorName"
  const cartKey = (sku, color) => `${sku}|||${color}`;
  const add = (sku, color) => setCart((prev) => ({ ...prev, [cartKey(sku, color)]: (prev[cartKey(sku, color)] || 0) + 1 }));
  const remove = (sku, color) => setCart((prev) => {
    const k = cartKey(sku, color);
    const next = { ...prev };
    if (next[k] > 1) next[k] -= 1; else delete next[k];
    return next;
  });
  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  const getColorIdx = (id) => selectedColors[id] ?? 0;
  const getCurrentImages = (p) => p.colors[getColorIdx(p.id)]?.images || [];

  const sendOrderToWhatsApp = () => {
    const lines = [];
    products.forEach((p) => {
      p.colors.forEach((c) => {
        const qty = cart[cartKey(p.id, c.name)];
        if (qty) lines.push(`${p.id} — ${c.name} × ${qty}`);
      });
      if (p.colors.length === 0 && cart[cartKey(p.id, "")]) {
        lines.push(`${p.id} — ${p.name} × ${cart[cartKey(p.id, "")]}`);
      }
    });
    if (lines.length === 0) { alert("먼저 상품을 담아줘"); return; }
    const header = `Hello! 👋%0A%0AI'd like to place an order:%0A%0A`;
    const body = lines.map(l => `📦 ${l}`).join("%0A");
    const footer = `%0A%0AThank you!`;
    window.open(`https://wa.me/?text=${header}${body}${footer}`, "_blank");
  };

  // 라이트박스 내비게이션
  const lbImages = lightbox ? getCurrentImages(products.find((p) => p.id === lightbox.productId) || { colors: [] }) : [];
  const lbPrev = () => setLightbox((l) => ({ ...l, imgIdx: (l.imgIdx - 1 + lbImages.length) % lbImages.length }));
  const lbNext = () => setLightbox((l) => ({ ...l, imgIdx: (l.imgIdx + 1) % lbImages.length }));

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Order</h2>
        <div>Cart {cartCount}</div>
      </div>

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search style #"
        style={{ width: "100%", height: 38, marginBottom: 12, boxSizing: "border-box", padding: "0 8px", border: "1px solid #ccc", borderRadius: 6 }}
      />

      {/* Products */}
      <div style={{ display: "grid", gap: 16, paddingBottom: 80 }}>
        {filtered.map((p) => {
          const colorIdx = getColorIdx(p.id);
          const images = getCurrentImages(p);
          const mainImage = images[0] || "";

          return (
            <div key={p.id} style={{ border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
              {/* 메인 이미지 - 클릭하면 라이트박스 */}
              <div
                style={{ background: "#f5f5f5", cursor: mainImage ? "pointer" : "default" }}
                onClick={() => mainImage && setLightbox({ productId: p.id, imgIdx: 0 })}
              >
                {mainImage ? (
                  <img
                    src={mainImage}
                    alt=""
                    style={{ width: "100%", maxHeight: 340, objectFit: "contain", display: "block" }}
                  />
                ) : (
                  <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "#aaa" }}>
                    No Image
                  </div>
                )}
              </div>

              {/* 썸네일 (이미지 여러장일 때) */}
              {images.length > 1 && (
                <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "8px", background: "#fafafa" }}>
                  {images.map((img, i) => (
                    <img
                      key={i}
                      src={img}
                      alt=""
                      onClick={() => setLightbox({ productId: p.id, imgIdx: i })}
                      style={{
                        width: 56, height: 56, objectFit: "cover", cursor: "pointer",
                        border: "2px solid transparent", borderRadius: 4,
                      }}
                    />
                  ))}
                </div>
              )}

              <div style={{ padding: "10px 12px" }}>
                {/* SKU + 이름 */}
                <div style={{ fontWeight: 700, fontSize: 17 }}>{p.id}</div>
                <div style={{ fontSize: 13, color: "#444", marginBottom: 8 }}>{p.name}</div>

                {/* 가격(왼쪽) + PACK(오른쪽) */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  {p.pack && (
                    <span style={{ fontSize: 11, background: "#111", color: "#fff", padding: "3px 8px", borderRadius: 4 }}>
                      PACK {p.pack}
                    </span>
                  )}
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{p.currency} {p.price}</span>
                </div>

                {/* ETA */}
                {p.eta && (
                  <div style={{ fontSize: 13, color: "#222", fontWeight: 700, marginBottom: 8 }}>ETA: {p.eta}</div>
                )}

                {/* 컬러별 Add 버튼 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(p.colors.length > 0 ? p.colors : [{ name: "", images: [] }]).map((c, i) => {
                    const qty = cart[cartKey(p.id, c.name)] || 0;
                    return (
                      <div
                        key={i}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                      >
                        {/* 컬러명 - 클릭하면 해당 컬러 사진으로 변경 */}
                        <div
                          onClick={() => setSelectedColors((prev) => ({ ...prev, [p.id]: i }))}
                          style={{
                            flex: 1, fontSize: 12, fontWeight: i === colorIdx ? 700 : 400,
                            color: i === colorIdx ? "#111" : "#666",
                            cursor: "pointer", textDecoration: i === colorIdx ? "underline" : "none",
                          }}
                        >
                          {c.name || p.name}
                        </div>
                        {/* +/- 수량 조절 */}
                        {qty > 0 ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <button onClick={() => remove(p.id, c.name)} style={{ width: 28, height: 28, borderRadius: 4, border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontWeight: 700 }}>−</button>
                            <span style={{ fontWeight: 700, minWidth: 20, textAlign: "center" }}>{qty}</span>
                            <button onClick={() => add(p.id, c.name)} style={{ width: 28, height: 28, borderRadius: 4, border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontWeight: 700 }}>+</button>
                          </div>
                        ) : (
                          <button
                            onClick={() => add(p.id, c.name)}
                            style={{ padding: "5px 16px", background: "#222", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13 }}
                          >
                            Add
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* WhatsApp 버튼 */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "white", padding: 10, borderTop: "1px solid #eee" }}>
        <button
          onClick={sendOrderToWhatsApp}
          style={{ width: "100%", height: 44, background: "#25D366", color: "white", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 15 }}
        >
          Send Order via WhatsApp
        </button>
      </div>

      {/* 라이트박스 모달 */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
        >
          <img
            src={lbImages[lightbox.imgIdx]}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "90vw", maxHeight: "90vh", objectFit: "contain" }}
          />
          {lbImages.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); lbPrev(); }}
                style={{ position: "absolute", left: 16, top: "50%", transform: "translateY(-50%)", background: "rgba(255,255,255,0.2)", color: "#fff", border: "none", borderRadius: "50%", width: 44, height: 44, fontSize: 20, cursor: "pointer" }}
              >‹</button>
              <button
                onClick={(e) => { e.stopPropagation(); lbNext(); }}
                style={{ position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)", background: "rgba(255,255,255,0.2)", color: "#fff", border: "none", borderRadius: "50%", width: 44, height: 44, fontSize: 20, cursor: "pointer" }}
              >›</button>
              <div style={{ position: "absolute", bottom: 20, color: "#fff", fontSize: 13 }}>
                {lightbox.imgIdx + 1} / {lbImages.length}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
