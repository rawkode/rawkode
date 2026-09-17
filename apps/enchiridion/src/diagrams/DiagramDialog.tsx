import { Component, Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DiagramDialogProps, DiagramExporter } from './types';
import './diagrams.css';

const DrawingEditor = lazy(() => import('./DrawingEditor'));
const D2Editor = lazy(() => import('./D2Editor'));

export type { DiagramDialogProps, DiagramExport, DiagramKind } from './types';

export default function DiagramDialog({ kind, source, onSave, onCancel }: DiagramDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const exporter = useRef<DiagramExporter | null>(null);
  const active = useRef(false);
  const phaseRef = useRef<'idle' | 'exporting' | 'saving'>('idle');
  const operation = useRef(0);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'exporting' | 'saving'>('idle');
  const [error, setError] = useState('');
  const titleID = useId();

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    element?.showModal();
    return () => { active.current = false; operation.current += 1; element?.close(); };
  }, []);

  useEffect(() => {
    const requested = () => setError('Finish saving or cancel this diagram before quitting.');
    window.addEventListener('enchiridion-quit-requested', requested);
    return () => window.removeEventListener('enchiridion-quit-requested', requested);
  }, []);

  useEffect(() => { if (content.current) content.current.inert = phase !== 'idle'; }, [phase]);

  const registerExporter = useCallback((value: DiagramExporter | null) => {
    exporter.current = value;
    setReady(value !== null);
  }, []);

  async function save() {
    if (!exporter.current || phaseRef.current !== 'idle') return;
    const token = ++operation.current;
    phaseRef.current = 'exporting';
    setPhase('exporting');
    setError('');
    try {
      const result = await withExportTimeout(exporter.current());
      if (!active.current || token !== operation.current) return;
      phaseRef.current = 'saving';
      setPhase('saving');
      await onSave(result);
    } catch (reason) {
      if (active.current && token === operation.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (active.current && token === operation.current) {
        phaseRef.current = 'idle';
        setPhase('idle');
      }
    }
  }

  function cancel() {
    if (phaseRef.current === 'saving') return;
    operation.current += 1;
    phaseRef.current = 'idle';
    setPhase('idle');
    onCancel();
  }

  return (
    <dialog
      ref={dialog}
      className="diagram-dialog"
      aria-labelledby={titleID}
      onCancel={event => event.preventDefault()}
      onKeyDown={event => {
        event.stopPropagation();
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void save();
        }
      }}
    >
      <header className="diagram-dialog-header">
        <button type="button" onClick={cancel} disabled={phase === 'saving'}>Cancel</button>
        <h2 id={titleID}>{kind === 'd2' ? 'D2 diagram' : 'Drawing'}</h2>
        <button type="button" className="diagram-done" onClick={() => void save()} disabled={!ready || phase !== 'idle'}>
          {phase === 'saving' ? 'Saving…' : phase === 'exporting' ? 'Exporting…' : 'Done'}
        </button>
      </header>
      <div ref={content} className="diagram-dialog-content" aria-busy={!ready || phase !== 'idle'}>
        <EditorBoundary>
          <Suspense fallback={<p className="diagram-loading" role="status">Opening editor…</p>}>
            {kind === 'excalidraw'
              ? <DrawingEditor source={source} onReady={registerExporter} />
              : <D2Editor source={source} onReady={registerExporter} />}
          </Suspense>
        </EditorBoundary>
      </div>
      {error && <p className="diagram-save-error" role="alert">{error}</p>}
    </dialog>
  );
}

async function withExportTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Export took too long. Try again or cancel without changing the note.')), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class EditorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(reason: unknown) {
    return { error: reason instanceof Error ? reason.message : String(reason) };
  }

  render() {
    return this.state.error
      ? <p className="diagram-loading diagram-render-error" role="alert">Unable to open diagram: {this.state.error}</p>
      : this.props.children;
  }
}
