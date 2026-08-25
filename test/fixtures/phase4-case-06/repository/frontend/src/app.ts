const gatewayUrl = process.env.GATEWAY_URL ?? "http://gateway:3000";

export async function submitOrder(payload: unknown): Promise<unknown> {
  const response = await fetch(`${gatewayUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

