exports.handler = async (event) => {
  const token = process.env.VITE_MAGENTO_TOKEN;
  const restPath = event.path.replace(/^\/rest\//, "");
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
