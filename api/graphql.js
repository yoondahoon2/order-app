export default async function handler(req, res) {
  const response = await fetch("https://www.editbynine.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": req.headers.authorization || "",
    },
    body: JSON.stringify(req.body),
  });
  const data = await response.json();
  res.status(response.status).json(data);
}
