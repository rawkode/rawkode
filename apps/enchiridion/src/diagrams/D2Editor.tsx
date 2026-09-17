import { useEffect, useRef, useState } from 'react';
import { renderD2 } from './d2Engine';
import { validateD2Source } from './limits';
import { svgToPNG } from './exportPreview';
import type { DiagramEditorProps } from './types';

export default function D2Editor({ source: initial, onReady }: DiagramEditorProps) {
  const [source, setSource] = useState(() => { validateD2Source(initial); return initial; });
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(false);
  const latestSource = useRef(source);
  latestSource.current = source;

  useEffect(() => {
    if (!source.trim()) {
      setPreview('');
      setError('');
      setRendering(false);
      return;
    }
    const controller = new AbortController();
    setRendering(true);
    const timer = window.setTimeout(() => {
      renderD2(source, controller.signal)
        .then(svg => {
          if (!controller.signal.aborted) {
            setPreview(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
            setError('');
          }
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(reason));
        })
        .finally(() => { if (!controller.signal.aborted) setRendering(false); });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source]);

  useEffect(() => {
    onReady(async () => {
      const current = latestSource.current;
      validateD2Source(current);
      if (!current.trim()) return { source: current };
      const svg = await renderD2(current);
      return { source: current, previewDataURL: await svgToPNG(svg) };
    });
    return () => onReady(null);
  }, [onReady]);

  return (
    <div className="diagram-d2">
      <section className="diagram-source">
        <label htmlFor="diagram-d2-source">D2 source</label>
        <textarea
          id="diagram-d2-source"
          aria-describedby="diagram-d2-hint"
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={source}
          onChange={event => {
            try { validateD2Source(event.target.value); setSource(event.target.value); setError(''); }
            catch (reason) { setError(errorMessage(reason)); }
          }}
          placeholder={'direction: right\nIdeas -> Notes -> Diagrams'}
        />
        <p id="diagram-d2-hint">Live preview · TALA layout</p>
      </section>
      <section className="diagram-preview" aria-label="Diagram preview" aria-busy={rendering}>
        {error ? <p className="diagram-render-error" role="alert">{error}</p>
          : preview ? <img src={preview} alt="Your rendered D2 diagram" />
          : <p className="diagram-placeholder">{rendering ? 'Preparing preview…' : 'Your diagram will appear here.'}</p>}
        {rendering && preview && <span className="diagram-rendering" role="status">Updating…</span>}
      </section>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
