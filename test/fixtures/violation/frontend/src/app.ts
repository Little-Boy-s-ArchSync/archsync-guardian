const gatewayUrl = process.env.GATEWAY_URL ?? "http://gateway:3000";

export async function submit(): Promise<void> {
  await fetch(`${gatewayUrl}/orders`);
}
