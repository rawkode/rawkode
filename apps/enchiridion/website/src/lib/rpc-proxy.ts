/** Bound the request before passing it to the service; never forward caller-supplied identity. */
export async function proxyRpc(request: Request, binding: { fetch(request: Request): Promise<Response> }, ownerId: string): Promise<Response> {
  if (!request.headers.get("Content-Type")?.startsWith("text/plain") && !request.headers.get("Content-Type")?.startsWith("application/json")) {
    return new Response("Unsupported content type", { status: 415 });
  }
  const reader = request.body?.getReader();
  if (!reader) return new Response("RPC body required", { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) { await reader.cancel(); return new Response("RPC request too large", { status: 413 }); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  const response = await binding.fetch(new Request("https://service.internal/rpc", { method: "POST", body,
    headers: { "Content-Type": request.headers.get("Content-Type")!, "X-Enchiridion-Owner": ownerId } }));
  return new Response(response.body, { status: response.status, headers: { "Content-Type": response.headers.get("Content-Type") || "text/plain", "Cache-Control": "no-store" } });
}
