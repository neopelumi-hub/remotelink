// =============================================
// RemoteLink - Icon Generator
// Generates app icon (PNG + ICO) using sharp
// =============================================

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 32, 48, 128, 256];
const OUTPUT_DIR = path.join(__dirname, '..', 'assets');

// SVG icon: dark rounded rect with cyan "RL" monitor/link symbol
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="48" fill="#0d1117"/>
  <rect x="28" y="28" width="200" height="200" rx="32" fill="none" stroke="#1e293b" stroke-width="4"/>
  <!-- Monitor shape -->
  <rect x="56" y="64" width="144" height="100" rx="12" fill="none" stroke="#22d3ee" stroke-width="6"/>
  <rect x="68" y="76" width="120" height="76" rx="4" fill="#0891b2" opacity="0.15"/>
  <!-- Monitor stand -->
  <line x1="128" y1="164" x2="128" y2="184" stroke="#22d3ee" stroke-width="6" stroke-linecap="round"/>
  <line x1="96" y1="184" x2="160" y2="184" stroke="#22d3ee" stroke-width="6" stroke-linecap="round"/>
  <!-- RL text -->
  <text x="128" y="134" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-weight="800" font-size="48" fill="#22d3ee">RL</text>
</svg>
`;

async function generateIcons() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Generate 256x256 PNG
  const pngBuffer = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.png'), pngBuffer);
  console.log('Generated assets/icon.png (256x256)');

  // Generate individual size PNGs for ICO
  const images = [];
  for (const size of SIZES) {
    const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
    images.push({ size, buf });
  }

  // Build ICO file (multi-resolution)
  const icoBuffer = buildIco(images);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.ico'), icoBuffer);
  console.log(`Generated assets/icon.ico (${SIZES.join(', ')}px)`);
}

function buildIco(images) {
  // ICO format: header + directory entries + image data
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * images.length;
  let dataOffset = headerSize + dirSize;

  // Calculate total size
  let totalSize = dataOffset;
  for (const img of images) {
    totalSize += img.buf.length;
  }

  const buffer = Buffer.alloc(totalSize);

  // ICO Header
  buffer.writeUInt16LE(0, 0);          // Reserved
  buffer.writeUInt16LE(1, 2);          // Type: 1 = ICO
  buffer.writeUInt16LE(images.length, 4); // Image count

  // Directory entries
  let offset = dataOffset;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const entryOffset = headerSize + i * dirEntrySize;
    buffer.writeUInt8(img.size >= 256 ? 0 : img.size, entryOffset);     // Width (0 = 256)
    buffer.writeUInt8(img.size >= 256 ? 0 : img.size, entryOffset + 1); // Height (0 = 256)
    buffer.writeUInt8(0, entryOffset + 2);    // Color palette
    buffer.writeUInt8(0, entryOffset + 3);    // Reserved
    buffer.writeUInt16LE(1, entryOffset + 4); // Color planes
    buffer.writeUInt16LE(32, entryOffset + 6); // Bits per pixel
    buffer.writeUInt32LE(img.buf.length, entryOffset + 8);  // Image size
    buffer.writeUInt32LE(offset, entryOffset + 12);          // Image offset
    offset += img.buf.length;
  }

  // Image data (PNG buffers embedded directly)
  offset = dataOffset;
  for (const img of images) {
    img.buf.copy(buffer, offset);
    offset += img.buf.length;
  }

  return buffer;
}

generateIcons().catch(err => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
