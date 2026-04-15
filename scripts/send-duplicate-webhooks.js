const baseUrl = process.env.BASE_URL || "http://localhost:3000";

async function post(body) {
  const response = await fetch(`${baseUrl}/webhooks/demo`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return response.json();
}

async function main() {
  const event = {
    type: "customer.updated",
    resourceKey: "customer-dup",
    dedupeKey: "evt-dup-1",
    payload: {
      email: "dup@example.com",
      tier: "plus",
      changeNumber: 1
    }
  };

  const responses = [];
  responses.push(await post(event));
  responses.push(await post(event));

  console.log(JSON.stringify({ duplicateDemo: responses }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
