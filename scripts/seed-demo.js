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
  const events = [
    {
      type: "customer.updated",
      resourceKey: "customer-100",
      dedupeKey: "evt-100",
      payload: { email: "one@example.com", tier: "pro", changeNumber: 1 }
    },
    {
      type: "customer.updated",
      resourceKey: "customer-ordered",
      dedupeKey: "evt-ordered-1",
      payload: { email: "first@example.com", tier: "starter", changeNumber: 1 }
    },
    {
      type: "customer.updated",
      resourceKey: "customer-ordered",
      dedupeKey: "evt-ordered-2",
      payload: { email: "second@example.com", tier: "growth", changeNumber: 2 }
    },
    {
      type: "customer.updated",
      resourceKey: "customer-fail",
      dedupeKey: "evt-fail",
      payload: { email: "fail@example.com", tier: "team", failMode: "untilReplay" }
    }
  ];

  const responses = [];
  for (const event of events) {
    responses.push(await post(event));
  }

  console.log(JSON.stringify({ seeded: responses }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
