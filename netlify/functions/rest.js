exports.handler = async (event) => {
  const token = process.env.VITE_MAGENTO_TOKEN;
  // path: e.g. "V1/products"
  const restPath = event.path.replace("/.netlify/functions/rest/", "");
  const qs = event.rawQuery ? "?" + event.rawQuery : "";
  const url = `https://www.editbynine.com/rest/${restPath}${qs}`;

  const response = await fetch(url, {
    method: event.httpMethod,
    headers: { "Authorization": `Bearer ${token}` },
  });
  const data = await response.text();
  return {
    statusCode: response.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: data,
  };
};
