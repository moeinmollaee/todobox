const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

function makePng(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.46;
  const thickness = Math.max(1.4, size * 0.075);
  const a1x = size * 0.28;
  const a1y = size * 0.52;
  const a2x = size * 0.44;
  const a2y = size * 0.68;
  const a3x = size * 0.74;
  const a3y = size * 0.36;

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const edge = Math.max(0, Math.min(1, r - d + 0.6));
      let rC = 15;
      let gC = 110;
      let bC = 98;
      let a = Math.round(255 * Math.min(1, edge * 2.4));
      const check = Math.min(
        distToSeg(x + 0.5, y + 0.5, a1x, a1y, a2x, a2y),
        distToSeg(x + 0.5, y + 0.5, a2x, a2y, a3x, a3y)
      );
      if (d <= r - 1 && check < thickness) {
        const k = Math.max(0, Math.min(1, (thickness - check) / 1.2));
        rC = Math.round(15 + (255 - 15) * k);
        gC = Math.round(110 + (255 - 110) * k);
        bC = Math.round(98 + (255 - 98) * k);
      }
      const i = row + 1 + x * 4;
      raw[i] = rC;
      raw[i + 1] = gC;
      raw[i + 2] = bC;
      raw[i + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, "..", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128, 192, 512]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), makePng(size));
}
console.log("icons written");
