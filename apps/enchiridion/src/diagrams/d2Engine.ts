import { D2 } from '@d2lang/d2';
import { validateD2Source } from './limits';

// The WebKit transport runs Go in this document. Reuse its one lazy instance;
// closing and reopening a dialog must not allocate another WASM runtime.
let engine: D2 | undefined;
let tail: Promise<unknown> = Promise.resolve();

export function renderD2(source: string, signal?: AbortSignal): Promise<string> {
  validateD2Source(source);
  const task = tail.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    engine ??= new D2();
    const result = await engine.compile(source, { layout: 'tala', pad: 32 });
    signal?.throwIfAborted();
    return engine.render(result.diagram, result.renderOptions);
  });
  tail = task;
  return task;
}
