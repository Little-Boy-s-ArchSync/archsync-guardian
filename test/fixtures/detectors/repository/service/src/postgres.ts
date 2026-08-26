import { Client } from "pg";

const database = new Client({ connectionString: process.env.DATABASE_URL });

export async function readDatabase(): Promise<void> {
  await database.query("select 1");
}
