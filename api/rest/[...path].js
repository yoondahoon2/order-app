export default async function handler(req, res) {
  const path = Array.isArray(req.query.path) ? req.query.path.join("/") : req.query.path;
  const queryString = req.url.split("?")[1] || "";
  const url = `https://www.editbynine.com/rest/${path}${queryString ? "?" + queryString : ""}`;

  const response = await fetch(url, {
    method: req.method,
    headers: {
      "Authorization": req.headers.authorization || "",
    },
  });
  const data = await response.json();
  res.status(response.status).json(data);
}
