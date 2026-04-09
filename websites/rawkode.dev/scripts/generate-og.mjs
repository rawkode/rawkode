/**
 * Generates /public/og.png at build time using sharp (SVG → PNG + photo composite).
 * Run with: node scripts/generate-og.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(__dirname, '../public/og.png');
const photoFile = path.resolve(__dirname, '../src/assets/rawkode.jpg');

// Approximate oklch(68% 0.20 250) in sRGB — site accent blue
const ACCENT = '#5a82e8';
const BG_DARK = '#0b0b0f';
const TEXT_PRIMARY = '#f0f0f6';
const TEXT_SECONDARY = '#8888aa';

const WIDTH = 1200;
const HEIGHT = 630;
const PHOTO_W = 420;
const PHOTO_H = HEIGHT;

// Left column text area
const TEXT_AREA_W = WIDTH - PHOTO_W;

const svgBg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${BG_DARK}"/>
      <stop offset="100%" stop-color="#0e0e1a"/>
    </linearGradient>
    <!-- Fade photo edge into background on the left side -->
    <linearGradient id="photo-fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${BG_DARK}"/>
      <stop offset="55%" stop-color="${BG_DARK}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg-grad)"/>

  <!-- Accent glow top-left -->
  <ellipse cx="0" cy="0" rx="500" ry="380" fill="${ACCENT}" fill-opacity="0.07"/>

  <!-- Left accent bar -->
  <rect x="72" y="96" width="4" height="80" rx="2" fill="${ACCENT}"/>

  <!-- "aka rawkode" -->
  <text x="96" y="130" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="18" font-weight="600" letter-spacing="0.12em" fill="${ACCENT}" opacity="0.9">aka rawkode</text>

  <!-- Name -->
  <text x="96" y="230" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="88" font-weight="800" letter-spacing="-0.02em" fill="${TEXT_PRIMARY}">David</text>
  <text x="96" y="332" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="88" font-weight="800" letter-spacing="-0.02em" fill="${TEXT_PRIMARY}">Flanagan</text>

  <!-- Divider -->
  <line x1="96" y1="370" x2="480" y2="370" stroke="${TEXT_SECONDARY}" stroke-width="1" stroke-opacity="0.3"/>

  <!-- Roles -->
  <text x="96" y="408" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="20" font-weight="400" letter-spacing="0.04em" fill="${TEXT_SECONDARY}">Developer · Open Source · Educator</text>

  <!-- Lead -->
  <text x="96" y="452" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="17" fill="${TEXT_SECONDARY}" opacity="0.7">Building developer tooling, cloud-native</text>
  <text x="96" y="476" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="17" fill="${TEXT_SECONDARY}" opacity="0.7">infrastructure, and teaching through</text>
  <text x="96" y="500" font-family="ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif"
    font-size="17" fill="${TEXT_SECONDARY}" opacity="0.7">Rawkode Academy.</text>

  <!-- rawkode.dev watermark -->
  <text x="96" y="${HEIGHT - 40}" font-family="ui-monospace, 'SF Mono', Menlo, monospace"
    font-size="18" font-weight="500" fill="${TEXT_SECONDARY}" opacity="0.5">rawkode.dev</text>

  <!-- Fade overlay on the right edge of text area (photo blend) -->
  <rect x="${TEXT_AREA_W - 80}" y="0" width="80" height="${HEIGHT}" fill="url(#photo-fade)"/>
</svg>`;

async function generate() {
  // Resize photo to fill right column, crop to center
  const photo = await sharp(photoFile)
    .resize(PHOTO_W, PHOTO_H, { fit: 'cover', position: 'top' })
    .toBuffer();

  // Render the background SVG to PNG
  const bg = await sharp(Buffer.from(svgBg)).png().toBuffer();

  // Composite: background first, then photo at right edge, then a gradient fade over it
  await sharp(bg)
    .composite([
      { input: photo, left: TEXT_AREA_W, top: 0, blend: 'over' },
    ])
    .png({ quality: 95, compressionLevel: 9 })
    .toFile(outFile);

  console.log(`✓ og.png generated → ${outFile}`);
}

generate().catch((err) => {
  console.error('✗ Failed to generate og.png:', err.message);
  process.exit(1);
});
