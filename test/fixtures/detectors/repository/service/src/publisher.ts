import { connect } from "amqplib";

const connection = await connect(process.env.AMQP_URL);
const channel = await connection.createChannel();

export function publishEvent(): void {
  channel.sendToQueue("events", Buffer.from("ready"));
}
