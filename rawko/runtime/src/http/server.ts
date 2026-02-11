import type { EventStore } from "../runtime/event_store.ts";

export interface RuntimeServerHandles {
  manager: {
    setObjective: (text: string) => Promise<{ accepted: boolean; objective?: string }>;
    getSnapshot: () => Promise<unknown>;
    stop: () => Promise<unknown>;
  };
  user: {
    submit: (text: string) => Promise<{ accepted: boolean }>;
  };
  health: {
    tick: () => Promise<{ recovered: string[] }>;
  };
}

export interface RuntimeServerOptions {
  host: string;
  port: number;
  events: EventStore;
  handles: RuntimeServerHandles;
  onShutdown: () => Promise<void>;
}

export function startRuntimeServer(options: RuntimeServerOptions): Deno.HttpServer {
  return Deno.serve({ hostname: options.host, port: options.port }, async (request) => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/api/runtime/state") {
      const snapshot = await options.handles.manager.getSnapshot();
      return json(snapshot);
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/objective") {
      const body = await readJsonBody(request);
      const text = String(body?.text ?? "").trim();
      const result = await options.handles.manager.setObjective(text);
      if (!result.accepted) {
        return json({ error: "text is required" }, { status: 400 });
      }
      return json({ ok: true, objective: result.objective });
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/message") {
      const body = await readJsonBody(request);
      const text = String(body?.text ?? "").trim();
      const result = await options.handles.user.submit(text);
      if (!result.accepted) {
        return json({ error: "text is required" }, { status: 400 });
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/health/tick") {
      const result = await options.handles.health.tick();
      return json({ ok: true, recovered: result.recovered });
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/control/stop") {
      await options.handles.manager.stop();
      await options.onShutdown();
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/runtime/events") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const initial = options.events.listSince(Number.isFinite(offset) ? offset : 0);
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of initial) {
            controller.enqueue(encoder.encode(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`));
          }

          const unsubscribe = options.events.subscribe((event) => {
            controller.enqueue(encoder.encode(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`));
          });

          const heartbeat = setInterval(() => {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          }, 20_000);

          request.signal.addEventListener("abort", () => {
            clearInterval(heartbeat);
            unsubscribe();
            controller.close();
          }, { once: true });
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders(),
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
        },
      });
    }

    return json({ error: "not found" }, { status: 404 });
  });
}

function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [key, val] of Object.entries(corsHeaders())) {
    headers.set(key, val);
  }
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
