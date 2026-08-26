const orderServiceUrl = process.env.ORDER_SERVICE_URL ?? "http://order-service:3001";

export async function forwardOrder(payload: unknown): Promise<Response> {
  return fetch(`${orderServiceUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
