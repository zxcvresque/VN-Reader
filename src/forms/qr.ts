// Minimal QR Code generator: byte mode, error correction level M, versions 1–10.
// Enough for any form link (up to 213 bytes) without a third-party library.

// Per version: [error-correction codewords per block, blocks in group 1, data codewords per block, blocks in group 2]
// Group 2 blocks carry one more data codeword than group 1.
const BLOCKS: Array<[number, number, number, number]> = [[0, 0, 0, 0], [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0], [16, 4, 27, 0], [18, 4, 31, 0], [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1]];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const multiply = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function errorCorrection(data: number[], degree: number): number[] {
  // Generator polynomial: product of (x - 2^i) for i in 0..degree-1.
  const generator = new Array<number>(degree).fill(0); generator[degree - 1] = 1;
  for (let i = 0, root = 1; i < degree; i++) { for (let j = 0; j < degree; j++) { generator[j] = multiply(generator[j], root); if (j + 1 < degree) generator[j] ^= generator[j + 1]; } root = multiply(root, 2); }
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) { const factor = byte ^ (remainder.shift() as number); remainder.push(0); for (let i = 0; i < degree; i++) remainder[i] ^= multiply(generator[i], factor); }
  return remainder;
}

const dataCapacity = (version: number) => { const [, blocks1, size, blocks2] = BLOCKS[version]; return blocks1 * size + blocks2 * (size + 1); };

/** Returns a square matrix of booleans (true = dark module), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  while (version <= 10 && bytes.length + (version < 10 ? 2 : 3) > dataCapacity(version)) version++;
  if (version > 10) throw new Error("This link is too long for a QR code. Use a shorter custom link.");
  const capacity = dataCapacity(version), [ecLength, blocks1, blockSize, blocks2] = BLOCKS[version];

  const bits: number[] = [], push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(4, 4); push(bytes.length, version < 10 ? 8 : 16); for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const codewords: number[] = []; for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) codewords.push(pad);

  const dataBlocks: number[][] = [], ecBlocks: number[][] = [];
  for (let block = 0, offset = 0; block < blocks1 + blocks2; block++) { const length = blockSize + (block >= blocks1 ? 1 : 0), chunk = codewords.slice(offset, offset + length); offset += length; dataBlocks.push(chunk); ecBlocks.push(errorCorrection(chunk, ecLength)); }
  const stream: number[] = [];
  for (let i = 0; i <= blockSize; i++) for (const block of dataBlocks) if (i < block.length) stream.push(block[i]);
  for (let i = 0; i < ecLength; i++) for (const block of ecBlocks) stream.push(block[i]);

  const size = version * 4 + 17, modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false)), reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { if (x >= 0 && y >= 0 && x < size && y < size) { modules[y][x] = dark; reserved[y][x] = true; } };
  const finder = (cx: number, cy: number) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const distance = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, distance !== 2 && distance !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (const cy of ALIGN[version]) for (const cx of ALIGN[version]) { if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }
  for (let i = 8; i < size - 8; i++) { if (!reserved[6][i]) set(i, 6, i % 2 === 0); if (!reserved[i][6]) set(6, i, i % 2 === 0); }
  const format = (mask: number) => {
    const data = mask; // level M contributes the two high bits 00
    let remainder = data; for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const value = ((data << 10) | remainder) ^ 0x5412, bit = (i: number) => ((value >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) { let remainder = version; for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25); const value = (version << 12) | remainder; for (let i = 0; i < 18; i++) { const dark = ((value >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, dark); set(b, a, dark); } }

  const isData = reserved.map(row => row.map(cell => !cell));
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5; for (let vertical = 0; vertical < size; vertical++) for (let j = 0; j < 2; j++) { const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vertical : vertical; if (isData[y][x] && index < stream.length * 8) { modules[y][x] = ((stream[index >>> 3] >>> (7 - (index & 7))) & 1) === 1; index++; } } }

  const MASKS: Array<(x: number, y: number) => boolean> = [(x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const apply = (mask: number) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (isData[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x]; };
  const penalty = () => {
    let score = 0, dark = 0;
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) { let run = 1; for (let b = 1; b <= size; b++) { const current = b < size ? (pass ? modules[b][a] : modules[a][b]) : null, previous = pass ? modules[b - 1][a] : modules[a][b - 1]; if (current === previous) run++; else { if (run >= 5) score += run - 2; run = 1; } } }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const color = modules[y][x]; if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3; }
    const pattern = [true, false, true, true, true, false, true];
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) for (let b = 0; b <= size - 7; b++) { let match = true; for (let k = 0; k < 7 && match; k++) match = (pass ? modules[b + k][a] : modules[a][b + k]) === pattern[k]; if (!match) continue; const light = (from: number) => { for (let k = 0; k < 4; k++) { const p = from + k; if (p >= 0 && p < size && (pass ? modules[p][a] : modules[a][p])) return false; } return true; }; if (light(b - 4) || light(b + 7)) score += 40; }
    for (const row of modules) for (const cell of row) if (cell) dark++;
    return score + Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) { apply(mask); format(mask); const score = penalty(); if (score < bestScore) { bestScore = score; best = mask; } apply(mask); }
  apply(best); format(best);
  return modules;
}

/** SVG markup with a 4-module quiet zone. Colours are fixed dark-on-white so every scanner reads it. */
export function qrSvg(text: string, pixels = 512): string {
  const matrix = qrMatrix(text), quiet = 4, size = matrix.length + quiet * 2;
  let path = "";
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + quiet},${y + quiet}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
