// Renders the shield-with-check icon to icons/icon{16,32,48,128}.png.
// Pure Node (zlib only), so no image tooling is needed: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// Shape tests in unit coordinates (0..1).
function inShield(x, y) {
  const top = 0.08, mid = 0.52, bottom = 0.95, half = 0.38;
  if (y < top || y > bottom) return false;
  let w;
  if (y < mid) {
    // rounded top corners
    const r = 0.08, dy = top + r - y, dx = Math.abs(x - 0.5) - (half - r);
    if (dy > 0 && dx > 0) return dx * dx + dy * dy <= r * r;
    w = half;
  } else {
    w = half * (1 - Math.pow((y - mid) / (bottom - mid), 1.7));
  }
  return Math.abs(x - 0.5) <= w;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}
function inCheck(x, y) {
  const w = 0.055;
  return distToSegment(x, y, 0.32, 0.48, 0.45, 0.62) <= w || distToSegment(x, y, 0.45, 0.62, 0.69, 0.35) <= w;
}

function render(size) {
  const ss = 4; // supersampling per axis
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let shield = 0, check = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size, y = (py + (sy + 0.5) / ss) / size;
          if (inShield(x, y)) { shield++; if (inCheck(x, y)) check++; }
        }
      }
      const n = ss * ss, a = shield / n;
      const t = py / size; // vertical gradient #3b82f6 -> #1d4ed8
      const br = 59 + (29 - 59) * t, bg = 130 + (78 - 130) * t, bb = 246 + (216 - 246) * t;
      const c = shield ? check / shield : 0;
      const i = (py * size + px) * 4;
      out[i] = Math.round(br + (255 - br) * c);
      out[i + 1] = Math.round(bg + (255 - bg) * c);
      out[i + 2] = Math.round(bb + (255 - bb) * c);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, out);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), render(size));
  console.log(`icons/icon${size}.png`);
}
