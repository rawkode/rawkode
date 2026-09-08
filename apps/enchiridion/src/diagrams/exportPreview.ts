import { MAX_PREVIEW_BYTES, MAX_PREVIEW_EDGE } from './limits';

export async function pngDataURL(blob: Blob): Promise<string> {
  if (blob.size > MAX_PREVIEW_BYTES * 0.75) throw new Error('The diagram preview is too large.');
  const result = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('The preview could not be read.'));
    reader.onerror = () => reject(reader.error ?? new Error('The preview could not be read.'));
    reader.readAsDataURL(blob);
  });
  if (result.length > MAX_PREVIEW_BYTES || !result.startsWith('data:image/png;base64,')) {
    throw new Error('The diagram preview could not be exported as PNG.');
  }
  return result;
}

export async function svgToPNG(svg: string): Promise<string> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('The diagram has no visible size.');
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The diagram preview could not be created.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error('The diagram preview could not be created.')),
    'image/png',
  ));
  return pngDataURL(blob);
}
