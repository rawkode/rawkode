// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiagramDialog from './DiagramDialog';
import type { DiagramEditorProps, DiagramExport } from './types';

const { exportScene } = vi.hoisted(() => ({ exportScene: vi.fn() }));

vi.mock('./DrawingEditor', () => ({
  default: function MockDrawing({ onReady }: DiagramEditorProps) {
    useEffect(() => { onReady(exportScene); return () => onReady(null); }, [onReady]);
    return <div>Drawing canvas</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  exportScene.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(onSave = vi.fn(), onCancel = vi.fn()) {
  await act(async () => {
    root.render(<DiagramDialog kind="excalidraw" source="" onSave={onSave} onCancel={onCancel} />);
  });
  await act(async () => { await vi.dynamicImportSettled(); });
  return { onSave, onCancel };
}

function button(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!element) throw new Error(`Missing ${label} button`);
  return element;
}

describe('diagram save lifecycle', () => {
  it('lets Cancel invalidate a pending export without saving its late result', async () => {
    let resolve!: (result: DiagramExport) => void;
    exportScene.mockReturnValue(new Promise<DiagramExport>(done => { resolve = done; }));
    const { onSave, onCancel } = await mount();
    await act(async () => button('Done').click());
    expect(button('Cancel').disabled).toBe(false);
    await act(async () => button('Cancel').click());
    await act(async () => resolve({ source: 'late drawing' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('times out export and rejects late results while keeping Cancel available', async () => {
    let resolve!: (result: DiagramExport) => void;
    exportScene.mockReturnValue(new Promise<DiagramExport>(done => { resolve = done; }));
    const { onSave } = await mount();
    vi.useFakeTimers();
    await act(async () => button('Done').click());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Export took too long');
    expect(button('Cancel').disabled).toBe(false);
    expect(button('Done').disabled).toBe(false);
    await act(async () => resolve({ source: 'late drawing' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables Cancel only while the exported source is being committed', async () => {
    exportScene.mockResolvedValue({ source: 'drawing', previewDataURL: 'data:image/png;base64,AA==' });
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await mount(onSave);
    await act(async () => button('Done').click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ source: 'drawing', previewDataURL: 'data:image/png;base64,AA==' });
    expect(button('Cancel').disabled).toBe(true);
    await act(async () => finish());
    expect(button('Cancel').disabled).toBe(false);
  });
});
