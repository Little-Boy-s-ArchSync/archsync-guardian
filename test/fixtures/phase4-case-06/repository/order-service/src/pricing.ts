export function totalPrice(lines: Array<{ quantity: number; unitPrice: number }>): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}
