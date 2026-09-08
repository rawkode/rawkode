/**
 * Adapt D2 0.1.34's worker transport to the WKWebView document.
 * WebKit's worker stack overflows during Go package initialization, while the
 * document stack succeeds. The native host must dispose the webview on dismissal.
 * The D2/Go/ELK sources and WASM remain otherwise unchanged (MPL-2.0).
 */
export function patchD2(source) {
  const worker = 'return new Worker(URL.createObjectURL(E),{type:"module"})';
  const startup = '  go.run(result.instance);\n  return self.d2;';
  if (!source.includes(worker) || !source.includes(startup)) {
    throw new Error('Pinned D2 WebKit patch no longer matches upstream');
  }
  return source.replace(worker, `
    let terminated = false;
    const main = {
      terminate() { terminated = true; },
      postMessage(data) {
        if (!terminated) queueMicrotask(() => scope.onmessage({data}));
      }
    };
    const scope = {
      postMessage(data) {
        if (!terminated) queueMicrotask(() => main.onmessage?.({data}));
      }
    };
    const code = (await E.text())
      .replaceAll('export ', '')
      .replace('return self.d2;', 'return globalThis.d2;');
    new Function('self', code)(scope);
    return main;
  `).replace(startup, `
  let failure;
  delete globalThis.d2;
  go.run(result.instance).catch(error => { failure = error; });
  const deadline = Date.now() + 15000;
  while (!globalThis.d2) {
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error('D2 initialization timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return self.d2;`);
}
