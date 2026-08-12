const serviceUrl = process.env.SERVICE_URL ?? "http://service:3001";

export async function forward(): Promise<void> {
  await fetch(`${serviceUrl}/orders`);
}
