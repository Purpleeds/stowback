// Player drawings: custom body, face, hat, outfit and pet. Shared by the server (checks every
// drawing before passing it on) and the client (studio + rendering). Drawings are made in the
// game's drawing studio only; there is no image upload.
//
// A drawing mixes two kinds of art, painted in this order:
//   px: a pixel grid (bitmap), run-length encoded and base64'd: byte pairs [colour, run - 1],
//       colour 0 = empty, 1..pal.length = pal[colour - 1].
//   s:  smooth brush strokes (vector): [tool, colour, width, x1, y1, x2, y2, ...]
//       coordinates and width are in half units of the layer (0..2w, 0..2h).
// { pal: ['#rrggbb', ...], px?: string, s?: number[][] }

// Size of each layer in sprite units, and its pixel grid.
export const ART_LAYERS = {
  body: { w: 100, h: 150, gw: 50, gh: 75, name: 'Body' },
  face: { w: 42, h: 42, gw: 24, gh: 24, name: 'Face' },
  hat: { w: 100, h: 150, gw: 50, gh: 75, name: 'Hat' },
  outfit: { w: 100, h: 150, gw: 50, gh: 75, name: 'Outfit' },
  pet: { w: 80, h: 80, gw: 40, gh: 40, name: 'Pet' },
};
// Where the face sits on the character (sprite units, origin = feet).
export const FACE_BOX = { x: -21, y: -107, r: 21 };

export const STROKE = { brush: 0, line: 1, rect: 2, rectFill: 3, ellipse: 4, ellipseFill: 5, eraser: 6, shape: 7 };
export const ART_LIMITS = { colors: 32, pxChars: 12_000, strokes: 400, points: 6_000, width: 24, total: 60_000 };

export const BASE_PALETTE = [
  '#161A2E', '#3A3F55', '#6B7088', '#9AA1B9', '#DDE2EC', '#F7F8FB', '#FFFFFF', '#FF5B14',
  '#F2545B', '#B4436C', '#FF7AB6', '#FFE6DA', '#FFC93C', '#E08A1E', '#A8744F', '#5E4129',
  '#A3D94A', '#2DB87D', '#2CC6D6', '#3D7BFF', '#8B6CFF', '#2B3150', '#F2C79B', '#C68A5E',
];

const HEX = /^#[0-9A-F]{6}$/;

// ------------------------------------------------------------ grid encoding
export function encodeGrid(cells) {
  const bytes = [];
  for (let i = 0; i < cells.length;) {
    const c = cells[i];
    let n = 1;
    while (i + n < cells.length && cells[i + n] === c && n < 256) n++;
    bytes.push(c, n - 1);
    i += n;
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Returns a Uint8Array of exactly `count` cells, or null if the data is broken.
export function decodeGrid(px, count, colors) {
  let bin;
  try { bin = atob(px); } catch { return null; }
  if (bin.length % 2) return null;
  const out = new Uint8Array(count);
  let at = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const c = bin.charCodeAt(i); const n = bin.charCodeAt(i + 1) + 1;
    if (c > colors || at + n > count) return null;
    out.fill(c, at, at + n);
    at += n;
  }
  return at === count ? out : null;
}

// ------------------------------------------------------------ checking
// Returns a clean copy of one layer's drawing, or null if it's broken or empty.
export function checkDrawing(layer, d) {
  const L = ART_LAYERS[layer];
  if (!L || !d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (!Array.isArray(d.pal) || d.pal.length > ART_LIMITS.colors) return null;
  const pal = d.pal.map((c) => String(c).toUpperCase());
  if (!pal.every((c) => HEX.test(c))) return null;
  const out = { pal };
  if (d.px !== undefined) {
    if (typeof d.px !== 'string' || d.px.length > ART_LIMITS.pxChars) return null;
    const cells = decodeGrid(d.px, L.gw * L.gh, pal.length);
    if (!cells) return null;
    if (cells.some((c) => c)) out.px = d.px;
  }
  if (d.s !== undefined) {
    if (!Array.isArray(d.s) || d.s.length > ART_LIMITS.strokes) return null;
    let points = 0;
    const s = [];
    for (const st of d.s) {
      if (!Array.isArray(st) || st.length < 5 || st.length % 2 === 0) return null; // tool, colour, width + pairs
      if (!st.every((n) => Number.isInteger(n))) return null;
      const [tool, colour, width] = st;
      if (tool < 0 || tool > 7) return null;
      if (tool !== STROKE.eraser && (colour < 1 || colour > pal.length)) return null;
      if (width < 1 || width > ART_LIMITS.width * 2) return null;
      for (let i = 3; i < st.length; i += 2) {
        if (st[i] < 0 || st[i] > L.w * 2 || st[i + 1] < 0 || st[i + 1] > L.h * 2) return null;
      }
      points += (st.length - 3) / 2;
      if (points > ART_LIMITS.points) return null;
      s.push(st.slice());
    }
    if (s.length) out.s = s;
  }
  return out.px || out.s ? out : null;
}

// A player's whole set of drawings. Returns a clean object (possibly empty) or null if broken.
export function checkArt(art) {
  if (art === null || art === undefined) return {};
  if (typeof art !== 'object' || Array.isArray(art)) return null;
  let size = 0;
  try { size = JSON.stringify(art).length; } catch { return null; }
  if (size > ART_LIMITS.total) return null;
  const out = {};
  for (const layer of Object.keys(ART_LAYERS)) {
    if (art[layer] === undefined || art[layer] === null) continue;
    const d = checkDrawing(layer, art[layer]);
    if (!d) return null;
    out[layer] = d;
  }
  return out;
}

export function drawingHash(d) {
  const s = JSON.stringify(d);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
