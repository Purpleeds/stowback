// Map helpers shared by server (authoritative movement) and client (prediction, drawing).
// All coordinates are map units. Map format: see maps/kestrel-station.map.json and shared/mapcheck.js.
import { TASKS, FIX_POINTS, BASE_SPEED, MOVE_HZ } from './constants.js';

export function buildMap(json) {
  const rooms = json.rooms.map((r) => ({ ...r }));
  const rects = [...rooms, ...json.corridors].map(({ x, y, w, h }) => ({ x, y, w, h }));
  const roomOf = (x, y) => rooms.find((r) => inRect(r, x, y))?.id || null;

  const doors = json.doors.map((d) => ({ ...d }));
  const doorsByRoom = {};
  for (const d of doors) (doorsByRoom[d.room] ||= []).push(d);

  const taskSpots = {};
  for (const t of json.tasks) taskSpots[t.spot] = { spot: t.spot, x: t.x, y: t.y, room: roomOf(t.x, t.y) };

  const vents = {};
  const networks = {};
  for (const v of json.vents) {
    vents[v.id] = { ...v, room: roomOf(v.x, v.y) };
    (networks[v.network] ||= []).push(v.id);
  }
  const ventLinks = {};
  for (const ids of Object.values(networks)) for (const id of ids) ventLinks[id] = ids.filter((o) => o !== id);

  // Sabotage fix points, keyed by the ids in FIX_POINTS.
  const fix = {};
  for (const f of json.fixes || []) {
    const sabotage = Object.keys(FIX_POINTS).find((s) => FIX_POINTS[s].includes(f.id));
    if (sabotage) fix[f.id] = { id: f.id, sabotage, x: f.x, y: f.y, room: roomOf(f.x, f.y) };
  }
  const sabotages = Object.keys(FIX_POINTS).filter((s) => FIX_POINTS[s].every((id) => fix[id]));
  const tasks = Object.keys(TASKS).filter((id) => TASKS[id].stages.every((st) => taskSpots[st]));

  return {
    json,
    id: json.id || null,
    name: json.name,
    rects,
    rooms,
    roomById: Object.fromEntries(rooms.map((r) => [r.id, r])),
    doors,
    doorsByRoom,
    taskSpots,
    vents,
    ventNetworks: Object.values(networks),
    ventLinks,
    fix,
    sabotages, // sabotage types this map supports
    tasks, // task ids this map supports
    spawn: json.spawns,
    button: { x: json.button.x, y: json.button.y, room: roomOf(json.button.x, json.button.y) },
    size: json.size,
    solids: [tableSolid(json)].filter(Boolean), // things you can't walk through (the emergency table)
  };
}

export const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---------------------------------------------------------------- collision
// Each player collides with a small box around their feet (the shadow under the character),
// not the whole picture: the head and hat may overlap a wall behind them, the feet can't.
export const FEET = { hw: 6, hh: 3 }; // half width, half height in map units
const NUDGE = 8; // how far round a corner you get helped (map units)
const SWEEP_STEPS = 12; // precision of "walk right up to the wall" (1/4096 of a step)

// The emergency table is solid when it sits well inside a room with nothing else on it.
// Worked out from the map file alone, so the server, the game and the map maker always agree.
export const TABLE_R = 46;
export function tableSolid(json) {
  const b = json.button;
  if (!b || json.noTable) return null;
  const room = (json.rooms || []).find((r) => inRect(r, b.x, b.y));
  if (!room) return null;
  const need = TABLE_R + 16; // leave a walkway between the table and the walls
  if (b.x - need < room.x || b.x + need > room.x + room.w || b.y - need < room.y || b.y + need > room.y + room.h) return null;
  const points = [...(json.spawns || []), ...(json.vents || []), ...(json.tasks || []), ...(json.fixes || [])];
  if (points.some((q) => Math.hypot(q.x - b.x, q.y - b.y) < TABLE_R + 10)) return null;
  return { x: b.x, y: b.y, r: TABLE_R };
}

// Is the area [x0,x1]×[y0,y1] completely covered by floor rectangles? Exact for any layout:
// the box is cut along every rectangle edge inside it and each piece is checked.
function covered(rects, x0, y0, x1, y1) {
  const near = [];
  for (const r of rects) {
    const rx = r.x + r.w; const ry = r.y + r.h;
    if (r.x > x1 || rx < x0 || r.y > y1 || ry < y0) continue;
    if (r.x <= x0 && rx >= x1 && r.y <= y0 && ry >= y1) return true; // one rectangle holds it all
    near.push(r);
  }
  if (!near.length) return false;
  const xs = [x0, x1]; const ys = [y0, y1];
  for (const r of near) {
    if (r.x > x0 && r.x < x1) xs.push(r.x);
    if (r.x + r.w > x0 && r.x + r.w < x1) xs.push(r.x + r.w);
    if (r.y > y0 && r.y < y1) ys.push(r.y);
    if (r.y + r.h > y0 && r.y + r.h < y1) ys.push(r.y + r.h);
  }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i + 1] === xs[i]) continue;
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ys.length - 1; j++) {
      if (ys[j + 1] === ys[j]) continue;
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (!near.some((r) => inRect(r, cx, cy))) return false;
    }
  }
  return true;
}

// Can a player's feet be at (x, y)? Floor under the whole box, no locked door, no table.
export function canStand(map, x, y, locked, ignore) {
  const x0 = x - FEET.hw; const x1 = x + FEET.hw; const y0 = y - FEET.hh; const y1 = y + FEET.hh;
  if (locked && locked.size) {
    for (const d of map.doors) {
      if (locked.has(d.id) && !(ignore && ignore.has(d.id)) && x0 < d.x + d.w && x1 > d.x && y0 < d.y + d.h && y1 > d.y) return false;
    }
  }
  for (const c of map.solids || []) {
    const nx = Math.min(x1, Math.max(x0, c.x)) - c.x; const ny = Math.min(y1, Math.max(y0, c.y)) - c.y;
    if (nx * nx + ny * ny < c.r * c.r) return false;
  }
  return covered(map.rects, x0, y0, x1, y1);
}

// Moves along one axis (0 = x, 1 = y) up to the wall. If you walk straight into a corner by a few
// units (a doorway you're slightly off from), you're slid round it instead of stopping dead.
function axisMove(free, x, y, d, other, axis) {
  const at = (t) => (axis === 0 ? [x + d * t, y] : [x, y + d * t]);
  let [nx, ny] = at(1);
  if (free(nx, ny)) return [nx, ny];
  let lo = 0; let hi = 1;
  for (let i = 0; i < SWEEP_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const [mx, my] = at(mid);
    if (free(mx, my)) lo = mid; else hi = mid;
  }
  [nx, ny] = at(lo);
  const want = Math.abs(d);
  if (lo > 0.5 || Math.abs(other) > want * 0.35) return [nx, ny];
  // corner help: is there an opening just to one side?
  for (let o = 1; o <= NUDGE; o++) {
    const side = (s) => (axis === 0
      ? free(x + d, y + s * o) && free(x, y + s * o)
      : free(x + s * o, y + d) && free(x + s * o, y));
    const a = side(-1); const b = side(1);
    if (a && b) break; // dead centre on a pillar: no side is better
    if (a || b) {
      const s = a ? -1 : 1; const m = Math.min(want, o);
      const [sx, sy] = axis === 0 ? [nx, ny + s * m] : [nx + s * m, ny];
      if (free(sx, sy)) return [sx, sy];
      break;
    }
  }
  return [nx, ny];
}

// Walks (dx, dy) with collision. Slides along walls, stops exactly at them, rounds corners.
// Locked doors you are already standing in don't trap you, and if you're somehow stuck inside
// a wall you can walk out of it.
export function moveWithCollision(map, x, y, dx, dy, locked) {
  const ignore = new Set();
  if (locked && locked.size) {
    const x0 = x - FEET.hw; const x1 = x + FEET.hw; const y0 = y - FEET.hh; const y1 = y + FEET.hh;
    for (const d of map.doors) if (locked.has(d.id) && x0 < d.x + d.w && x1 > d.x && y0 < d.y + d.h && y1 > d.y) ignore.add(d.id);
  }
  const free = (px, py) => canStand(map, px, py, locked, ignore);
  if (!free(x, y)) return moveGhost(map, x, y, dx, dy);
  let nx = x; let ny = y;
  if (dx) [nx, ny] = axisMove(free, nx, ny, dx, dy, 0);
  if (dy) [nx, ny] = axisMove(free, nx, ny, dy, dx, 1);
  return [nx, ny];
}

// Ghosts float through walls but stay on the station.
export function moveGhost(map, x, y, dx, dy) {
  return [Math.min(map.size.w, Math.max(0, x + dx)), Math.min(map.size.h, Math.max(0, y + dy))];
}

// One movement step, exactly as the server runs it. ix, iy = stick direction in hundredths (-100..100).
// The game and the lobby predict your own steps with this same function, so they match the server.
export function stepPlayer(map, x, y, ix, iy, { speed = 1, ghost = false, locked } = {}) {
  let dx = ix / 100; let dy = iy / 100;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return [x, y];
  if (len > 1) { dx /= len; dy /= len; }
  const step = (BASE_SPEED * speed) / MOVE_HZ;
  return ghost ? moveGhost(map, x, y, dx * step, dy * step) : moveWithCollision(map, x, y, dx * step, dy * step, locked);
}

// The closest spot to (x, y) where a player fits (for spawning and teleports).
export function nearestStand(map, x, y) {
  if (canStand(map, x, y)) return [x, y];
  for (let r = 2; r <= 120; r += 2) {
    for (let a = 0; a < 16; a++) {
      const tx = x + Math.cos((a / 16) * Math.PI * 2) * r; const ty = y + Math.sin((a / 16) * Math.PI * 2) * r;
      if (canStand(map, tx, ty)) return [tx, ty];
    }
  }
  return [x, y];
}

export function roomAt(map, x, y) {
  const r = map.rooms.find((room) => inRect(room, x, y));
  return r ? r.id : null;
}

export const roomName = (map, id) => (id && map.roomById[id]?.name) || 'Hallway';

export function nearestVent(map, x, y, range) {
  let best = null;
  let bestD = range;
  for (const v of Object.values(map.vents)) {
    const d = dist(x, y, v.x, v.y);
    if (d <= bestD) { best = v; bestD = d; }
  }
  return best;
}
