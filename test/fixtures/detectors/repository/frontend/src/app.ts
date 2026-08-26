const serviceUrl = process.env.SERVICE_URL ?? "http://service:3000";

export async function requestStatus(): Promise<void> {
  await fetch(`${serviceUrl}/health`);
}
