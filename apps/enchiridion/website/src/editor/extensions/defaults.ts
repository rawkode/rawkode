import { extensions } from './registry';

// Build-time composition root. Swap this module to choose another trusted extension set.
extensions.register({ id: 'd2', version: 1, label: 'D2 diagram', description: 'Turn a few lines into a diagram', initialSource: 'idea: An idea\nplan: A plan\nidea -> plan',
  validate(source) { if (source.length > 100_000) throw new Error('D2 source is too large'); },
  load: () => import('./d2'),
});
extensions.register({ id: 'excalidraw', version: 1, label: 'Drawing', description: 'Sketch freely with Excalidraw', initialSource: '',
  validate(source) {
    if (!source) return;
    const scene = JSON.parse(source);
    if (scene.type !== 'excalidraw' || scene.version !== 2 || !Array.isArray(scene.elements) || scene.elements.length > 5000) throw new Error('Unsupported drawing');
    if (scene.elements.some((element: { type?: string }) => element.type === 'image' || element.type === 'embeddable')) throw new Error('Embedded images and web content are not supported yet');
  },
  load: () => import('./drawing'),
});
