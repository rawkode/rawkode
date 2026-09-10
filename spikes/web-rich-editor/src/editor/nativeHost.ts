import type { z } from "zod";
import type { draftSchema } from "./persistence";

type Draft = z.infer<typeof draftSchema>;
type Host = { postMessage(message: unknown): Promise<unknown> };

function host(): Host | undefined {
  return (window as Window & { webkit?: { messageHandlers?: { fieldnotes?: Host } } })
    .webkit?.messageHandlers?.fieldnotes;
}

export const nativeHost = {
  get available() { return !!host(); },
  async load(): Promise<unknown> {
    return host()!.postMessage({ version: 1, action: "load" });
  },
  async save(draft: Draft): Promise<void> {
    await host()!.postMessage({ version: 1, action: "save", draft });
  },
  async export(contents: string, filename: string): Promise<void> {
    await host()!.postMessage({ version: 1, action: "export", contents, filename });
  },
};
