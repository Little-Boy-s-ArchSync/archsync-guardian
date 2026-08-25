export function isValidOrder(order: { lines?: unknown[] }): boolean {
  return Array.isArray(order.lines) && order.lines.length > 0;
}
