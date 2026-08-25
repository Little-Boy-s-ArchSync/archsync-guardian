import { connect } from "amqplib";

const connection = await connect(process.env.AMQP_URL);
const channel = await connection.createChannel();

export async function consumeEvents(): Promise<void> {
  await channel.consume("events", () => undefined);
}
