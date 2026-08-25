import { createClient } from "redis";

const cache = createClient({ url: process.env.REDIS_URL });

export async function readCache(): Promise<void> {
  await cache.get("health");
}
