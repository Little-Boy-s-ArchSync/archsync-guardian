import { Client } from "pg";

const database = new Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:5432/app",
});

export async function save(value: unknown): Promise<void> {
  await database.query("insert into items(payload) values ($1)", [value]);
}
