import { D2 } from '@d2lang/d2';
import type { ExtensionSession } from './registry';

export async function mount(element: HTMLElement, source: string): Promise<ExtensionSession> {
  const engine = new D2();
  const input = document.createElement('textarea'); input.value = source; input.setAttribute('aria-label', 'D2 source'); input.spellcheck = false;
  const preview = document.createElement('img'); preview.alt = 'Diagram preview';
  const button = document.createElement('button'); button.textContent = 'Preview diagram';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  element.className = 'd2-workspace'; element.append(input, button, status, preview);
  let renderedSource = '', rendered = '', active = true;
  const render = async () => {
    button.disabled = true; status.textContent = 'Rendering…';
    try {
      const current = input.value;
      if (current.length > 100_000) throw new Error('Source too large');
      const compiled = await engine.compile(current, { layout: 'dagre', pad: 24 });
      const svg = await engine.render(compiled.diagram, compiled.renderOptions);
      if (!active) return;
      // SVG is rendered as an image, never inserted as active markup.
      let binary = ''; for (const byte of new TextEncoder().encode(svg)) binary += String.fromCharCode(byte);
      rendered = `data:image/svg+xml;base64,${btoa(binary)}`;
      renderedSource = current; preview.src = rendered; status.textContent = 'Preview ready';
    } catch { if (active) status.textContent = 'Could not render. Check the D2 source; it is still editable.'; }
    finally { if (active) button.disabled = false; }
  };
  button.onclick = () => { void render(); };
  void render();
  return { async read() { return { source: input.value, preview: renderedSource === input.value ? rendered : undefined }; }, destroy() { active = false; void engine.dispose(); element.replaceChildren(); } };
}
