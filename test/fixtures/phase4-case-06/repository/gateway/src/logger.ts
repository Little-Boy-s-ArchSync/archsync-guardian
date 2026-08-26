export function logRequest(method: string, path: string): void {
  console.info(JSON.stringify({ method, path }));
}
