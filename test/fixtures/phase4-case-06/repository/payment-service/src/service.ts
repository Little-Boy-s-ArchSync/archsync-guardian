import { Client } from "pg";

const database = new Client({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:5432/payments",
});

export async function capturePayment(payment: unknown): Promise<void> {
  await savePayment(payment);
}

async function savePayment(_payment: unknown): Promise<void> {
  await database.query("insert into payments(payload) values ($1)", [JSON.stringify(_payment)]);
}
