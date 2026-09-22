/**
 * Generates /public/og.png at build time using sharp (SVG → PNG + photo composite).
 * Mirrors the site's gig-poster system: ink background, signal-red name, and a
 * red/black duotone portrait with a halftone screen.
 * Run with: deno task generate-og
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(__dirname, '../public/og.png');
const photoFile = path.resolve(__dirname, '../src/assets/rawkode.jpg');

// sRGB approximations of the site tokens (see panda.config.ts).
const INK = '#110c0b'; // oklch(0.16 0.008 30)
const PAPER = '#f7f2f1'; // oklch(0.965 0.006 30)
const MUTED = '#a09694'; // oklch(0.68 0.012 30)
const SIGNAL = '#ff4632'; // oklch(0.665 0.225 30)

const WIDTH = 1200;
const HEIGHT = 630;
const PHOTO_W = 440;
const TEXT_X = 72;
const FONT = "'Archivo', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const svgBg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${INK}"/>

  <rect x="${TEXT_X}" y="92" width="16" height="16" fill="${SIGNAL}"/>
  <text x="${TEXT_X + 30}" y="107" font-family="${FONT}" font-size="24" font-style="italic" font-weight="500" fill="${PAPER}">rawkode, from Glasgow, Scotland</text>

  <text x="${TEXT_X - 4}" y="252" font-family="${FONT}" font-size="116" font-weight="900" letter-spacing="-2" fill="${PAPER}">DAVID</text>
  <!-- Sized for a regular-width system sans: librsvg cannot load the site's Archivo woff2. -->
  <text x="${TEXT_X - 4}" y="366" font-family="${FONT}" font-size="116" font-weight="900" letter-spacing="-2" fill="${SIGNAL}">FLANAGAN</text>

  <line x1="${TEXT_X}" y1="444" x2="${WIDTH - PHOTO_W - 56}" y2="444" stroke="${PAPER}" stroke-opacity="0.24"/>
  <text x="${TEXT_X}" y="482" font-family="${FONT}" font-size="22" fill="${MUTED}">Senior Solutions Engineer</text>
  <text x="${WIDTH - PHOTO_W - 56}" y="482" text-anchor="end" font-family="${FONT}" font-size="22" font-weight="700" fill="${PAPER}">CoreWeave</text>
  <line x1="${TEXT_X}" y1="506" x2="${WIDTH - PHOTO_W - 56}" y2="506" stroke="${PAPER}" stroke-opacity="0.24"/>
  <text x="${TEXT_X}" y="544" font-family="${FONT}" font-size="22" fill="${MUTED}">Founder</text>
  <text x="${WIDTH - PHOTO_W - 56}" y="544" text-anchor="end" font-family="${FONT}" font-size="22" font-weight="700" fill="${PAPER}">Rawkode Academy</text>
</svg>`;

const halftone = `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W}" height="${HEIGHT}">
  <defs>
    <pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse">
      <circle cx="3" cy="3" r="1.1" fill="#000" fill-opacity="0.3"/>
    </pattern>
  </defs>
  <rect width="${PHOTO_W}" height="${HEIGHT}" fill="url(#dots)"/>
</svg>`;

async function generate() {
  // Two-colour print: a high-contrast greyscale photo multiplied onto signal red.
  const grey = await sharp(photoFile)
    .resize(PHOTO_W, HEIGHT, { fit: 'cover', position: 'top' })
    .grayscale()
    .linear(1.35, -20)
    .toBuffer();

  const photo = await sharp({ create: { width: PHOTO_W, height: HEIGHT, channels: 3, background: SIGNAL } })
    .composite([
      { input: grey, blend: 'multiply' },
      { input: Buffer.from(halftone), blend: 'multiply' },
    ])
    .png()
    .toBuffer();

  const bg = await sharp(Buffer.from(svgBg)).png().toBuffer();

  await sharp(bg)
    .composite([{ input: photo, left: WIDTH - PHOTO_W, top: 0 }])
    .png({ quality: 95, compressionLevel: 9 })
    .toFile(outFile);

  console.log(`✓ og.png generated → ${outFile}`);
}

generate().catch((err) => {
  console.error('✗ Failed to generate og.png:', err.message);
  Deno.exit(1);
});
