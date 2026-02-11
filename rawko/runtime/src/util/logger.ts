export function log(message: string): void {
  console.log(`[rawko] ${message}`);
}

export function warn(message: string): void {
  console.warn(`[rawko] WARN: ${message}`);
}

export function err(message: string): void {
  console.error(`[rawko] ERROR: ${message}`);
}
