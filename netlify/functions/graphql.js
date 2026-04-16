exports.handler = async (event) => {
  const token = process.env.VITE_MAGENTO_TOKEN;
  const response = await fetch("https://www.editbynine.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: event.body,
  });
  const data = await response.text();
  return {
    statusCode: response.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: data,
  };
};
