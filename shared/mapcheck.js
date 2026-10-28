// Checks a map (from the map maker, a .stowmap file, or another player) and returns a clean copy.
// Used by the server before it accepts a custom map, and by the map maker to list problems.
// Never trust the input: every field is copied, clamped and checked here.
import { MAP_LIMITS, TASK_SPOTS, TASKS, FIX_POINTS, FIX_NAMES, SABOTAGES, RANGE } from './constants.js';
import { canStand as feetFit, tableSolid } from './map.js';

const L = MAP_LIMITS;
const CELL = 4; // walkability grid size in map units

const int = (v, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

// Returns { ok, map, errors: [{ msg, kind?, i? }], warnings: [...] }
export function validateMap(input) {
  const errors = [];
  const warnings = [];
  const err = (msg, kind, i) => errors.push({ msg, kind, i });
  const warn = (msg, kind, i) => warnings.push({ msg, kind, i });

  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > L.bytes) return { ok: false, errors: [{ msg: 'That map file is too big.' }], warnings };
    try { raw = JSON.parse(raw); } catch { return { ok: false, errors: [{ msg: 'That file isn’t a Stowaway map.' }], warnings }; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: [{ msg: 'That file isn’t a Stowaway map.' }], warnings };
  let size = 0;
  try { size = JSON.stringify(raw).length; } catch { size = Infinity; }
  if (size > L.bytes) return { ok: false, errors: [{ msg: 'That map is too big to share.' }], warnings };

  const W = int(raw.size?.w, L.minW, L.maxW) ?? L.minW;
  const H = int(raw.size?.h, L.minH, L.maxH) ?? L.minH;
  const map = {
    format: 'stowaway-map', version: 1,
    name: text(raw.name, L.nameMax) || 'Untitled map',
    size: { w: W, h: H },
    rooms: [], corridors: [], doors: [], vents: [], button: null, spawns: [], tasks: [], fixes: [],
  };
  if (cleanId(raw.id) && !['kestrel', 'lobby'].includes(raw.id)) map.id = raw.id;

  const usedIds = new Set();
  const uniqueId = (v, prefix) => {
    let id = cleanId(v);
    if (!id || usedIds.has(id)) { let n = 1; while (usedIds.has(`${prefix}${n}`)) n++; id = `${prefix}${n}`; }
    usedIds.add(id);
    return id;
  };
  const rectOf = (r, minSide) => {
    if (!r || typeof r !== 'object') return null;
    const x = int(r.x, 0, W); const y = int(r.y, 0, H);
    if (x === null || y === null) return null;
    const w = int(r.w, minSide, W - x); const h = int(r.h, minSide, H - y);
    if (w === null || h === null || w < minSide || h < minSide) return null;
    return { x, y, w, h };
  };
  const pointOf = (p) => {
    if (!p || typeof p !== 'object') return null;
    const x = int(p.x, 0, W); const y = int(p.y, 0, H);
    return x === null || y === null ? null : { x, y };
  };

  // ---- rooms & hallways
  const rawRooms = arr(raw.rooms);
  if (rawRooms.length > L.rooms) err(`Too many rooms (the most is ${L.rooms}).`, 'rooms');
  const names = new Set();
  rawRooms.slice(0, L.rooms).forEach((r, i) => {
    const rect = rectOf(r, 40);
    if (!rect) return err(`Room ${i + 1} is too small or off the map (rooms are at least 40×40).`, 'rooms', i);
    let name = text(r.name, L.roomNameMax) || `Room ${i + 1}`;
    if (names.has(name.toLowerCase())) { warn(`Two rooms are called "${name}".`, 'rooms', i); name = `${name} ${i + 1}`.slice(0, L.roomNameMax); }
    names.add(name.toLowerCase());
    map.rooms.push({ id: uniqueId(r.id, 'room'), name, ...rect });
  });
  const rawHalls = arr(raw.corridors);
  if (rawHalls.length > L.corridors) err(`Too many hallways (the most is ${L.corridors}).`, 'corridors');
  rawHalls.slice(0, L.corridors).forEach((c, i) => {
    const rect = rectOf(c, 16);
    if (!rect) return err(`Hallway ${i + 1} is too thin or off the map.`, 'corridors', i);
    map.corridors.push({ id: uniqueId(c.id, 'hall'), ...rect });
  });
  if (!map.rooms.length) err('Add at least one room.', 'rooms');

  // ---- walkability grid
  const gw = Math.ceil(W / CELL) + 1; const gh = Math.ceil(H / CELL) + 1;
  const floor = new Uint8Array(gw * gh);
  for (const r of [...map.rooms, ...map.corridors]) {
    for (let gy = Math.ceil(r.y / CELL); gy * CELL <= r.y + r.h; gy++) for (let gx = Math.ceil(r.x / CELL); gx * CELL <= r.x + r.w; gx++) floor[gy * gw + gx] = 1;
  }
  const onFloor = (x, y) => {
    for (const r of [...map.rooms, ...map.corridors]) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
    return false;
  };
  // the same feet box the game uses (shared/map.js), so "reachable" here means walkable in the game
  const geo = { rects: [...map.rooms, ...map.corridors], doors: [], solids: [] };
  const canStand = (x, y) => feetFit(geo, x, y);
  let standCache = new Int8Array(gw * gh); // 0 = not checked yet, 1 = fits, 2 = doesn't
  const cellStand = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return false;
    const k = gy * gw + gx;
    if (!standCache[k]) standCache[k] = floor[k] === 1 && feetFit(geo, gx * CELL, gy * CELL) ? 1 : 2;
    return standCache[k] === 1;
  };
  const roomAt = (x, y) => map.rooms.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) || null;
  const label = (x, y) => roomAt(x, y)?.name || 'a hallway';

  // ---- doors
  const rawDoors = arr(raw.doors);
  if (rawDoors.length > L.doors) err(`Too many doors (the most is ${L.doors}).`, 'doors');
  rawDoors.slice(0, L.doors).forEach((d, i) => {
    const rect = rectOf(d, 10);
    if (!rect || rect.w > 120 || rect.h > 120) return err(`Door ${i + 1} has a bad size.`, 'doors', i);
    let room = map.rooms.find((r) => r.id === d.room);
    const touches = (r) => rect.x <= r.x + r.w + 6 && rect.x + rect.w >= r.x - 6 && rect.y <= r.y + r.h + 6 && rect.y + rect.h >= r.y - 6;
    if (!room || !touches(room)) room = map.rooms.find(touches);
    if (!room) return err(`Door ${i + 1} isn’t next to a room.`, 'doors', i);
    if (!onFloor(rect.x + rect.w / 2, rect.y + rect.h / 2)) return err(`Door ${i + 1} isn’t on the floor. Put doors where a hallway meets a room.`, 'doors', i);
    map.doors.push({ id: uniqueId(d.id, 'door'), room: room.id, ...rect });
  });

  // ---- points
  const rawVents = arr(raw.vents);
  if (rawVents.length > L.vents) err(`Too many vents (the most is ${L.vents}).`, 'vents');
  rawVents.slice(0, L.vents).forEach((v, i) => {
    const p = pointOf(v);
    const network = int(v?.network, 1, 8);
    if (!p || network === null) return err(`Vent ${i + 1} is broken.`, 'vents', i);
    if (!canStand(p.x, p.y)) return err(`Vent ${i + 1} isn’t on the floor.`, 'vents', i);
    map.vents.push({ id: uniqueId(v.id, 'vent'), network, ...p });
  });
  const byNet = {};
  for (const v of map.vents) (byNet[v.network] ||= []).push(v);
  for (const [n, list] of Object.entries(byNet)) if (list.length < 2) err(`Vent group ${n} has only one vent. Add another vent to the same group.`, 'vents', map.vents.indexOf(list[0]));
  if (!map.vents.length) warn('No vents: stowaways won’t be able to vent.', 'vents');

  const b = pointOf(raw.button);
  if (!b) err('Add the emergency button.', 'button');
  else if (!onFloor(b.x, b.y)) err('The emergency button isn’t on the floor.', 'button');
  else map.button = b;

  const rawSpawns = arr(raw.spawns);
  rawSpawns.slice(0, L.spawns).forEach((s, i) => {
    const p = pointOf(s);
    if (!p || !canStand(p.x, p.y)) return err(`Start point ${i + 1} isn’t on the floor (leave room around it).`, 'spawns', i);
    map.spawns.push(p);
  });
  if (!map.spawns.length) err('Add at least one start point.', 'spawns');

  const seenSpots = new Set();
  arr(raw.tasks).slice(0, Object.keys(TASK_SPOTS).length * 2).forEach((t, i) => {
    const p = pointOf(t);
    if (!p || !TASK_SPOTS[t?.spot]) return err(`Task spot ${i + 1} is broken.`, 'tasks', i);
    if (seenSpots.has(t.spot)) return err(`There are two "${TASK_SPOTS[t.spot]}" spots. Each one can only be used once.`, 'tasks', i);
    if (!onFloor(p.x, p.y)) return err(`"${TASK_SPOTS[t.spot]}" isn’t on the floor.`, 'tasks', i);
    seenSpots.add(t.spot);
    map.tasks.push({ spot: t.spot, ...p });
  });
  const seenFix = new Set();
  arr(raw.fixes).slice(0, Object.keys(FIX_NAMES).length * 2).forEach((f, i) => {
    const p = pointOf(f);
    if (!p || !FIX_NAMES[f?.id]) return err(`Fix point ${i + 1} is broken.`, 'fixes', i);
    if (seenFix.has(f.id)) return err(`There are two "${FIX_NAMES[f.id]}" points.`, 'fixes', i);
    if (!onFloor(p.x, p.y)) return err(`"${FIX_NAMES[f.id]}" isn’t on the floor.`, 'fixes', i);
    seenFix.add(f.id);
    map.fixes.push({ id: f.id, ...p });
  });

  // ---- what the map supports
  const tasks = Object.keys(TASKS).filter((id) => TASKS[id].stages.every((s) => seenSpots.has(s)));
  for (const id of Object.keys(TASKS)) {
    const have = TASKS[id].stages.filter((s) => seenSpots.has(s)).length;
    if (have && have < TASKS[id].stages.length) warn(`"${TASKS[id].name}" needs all ${TASKS[id].stages.length} parts, so it won’t be used yet.`, 'tasks');
  }
  if (!tasks.length) err('Add at least one complete task.', 'tasks');
  for (const [s, ids] of Object.entries(FIX_POINTS)) {
    const have = ids.filter((id) => seenFix.has(id)).length;
    if (have && have < ids.length) warn(`${SABOTAGES[s].name} needs ${ids.map((id) => FIX_NAMES[id]).join(' and ')}, so it won’t be used yet.`, 'fixes');
  }
  if (!seenFix.size) warn('No fix points: stowaways can only lock doors.', 'fixes');

  // ---- can everything be reached from the first start point?
  if (map.spawns.length && !errors.some((e) => e.kind === 'spawns')) {
    // the emergency table is solid when it fits (decided after the points are known, see tableSolid)
    const table = tableSolid(map);
    if (table) { geo.solids.push(table); standCache = new Int8Array(gw * gh); }
    const seen = new Uint8Array(gw * gh);
    const s0 = map.spawns[0];
    let start = [Math.round(s0.x / CELL), Math.round(s0.y / CELL)];
    if (!cellStand(start[0], start[1])) {
      // the start point is off the grid: use the nearest grid point the player could step to
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
        if (cellStand(start[0] + ox, start[1] + oy)) { start = [start[0] + ox, start[1] + oy]; break; }
      }
    }
    if (cellStand(start[0], start[1])) {
      const q = [start]; seen[start[1] * gw + start[0]] = 1;
      while (q.length) {
        const [x, y] = q.pop();
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || seen[ny * gw + nx] || !cellStand(nx, ny)) continue;
          seen[ny * gw + nx] = 1; q.push([nx, ny]);
        }
      }
    }
    const reach = (x, y, range) => {
      const r = Math.floor(range / CELL);
      const cx = Math.round(x / CELL); const cy = Math.round(y / CELL);
      for (let gy = cy - r; gy <= cy + r; gy++) for (let gx = cx - r; gx <= cx + r; gx++) {
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh || !seen[gy * gw + gx]) continue;
        if (Math.hypot(gx * CELL - x, gy * CELL - y) <= range) return true;
      }
      return false;
    };
    map.spawns.forEach((p, i) => { if (!reach(p.x, p.y, 6)) err(`Start point ${i + 1} can’t be reached from start point 1.`, 'spawns', i); });
    if (map.button && !reach(map.button.x, map.button.y, RANGE.emergency - 6)) err(`Players can’t walk to the emergency button (in ${label(map.button.x, map.button.y)}).`, 'button');
    map.tasks.forEach((t, i) => { if (!reach(t.x, t.y, RANGE.use - 4)) err(`Players can’t reach "${TASK_SPOTS[t.spot]}" (in ${label(t.x, t.y)}).`, 'tasks', i); });
    map.fixes.forEach((f, i) => { if (!reach(f.x, f.y, RANGE.fix - 4)) err(`Players can’t reach "${FIX_NAMES[f.id]}" (in ${label(f.x, f.y)}).`, 'fixes', i); });
    map.vents.forEach((v, i) => { if (!reach(v.x, v.y, RANGE.vent - 4)) err(`Players can’t reach vent ${i + 1} (in ${label(v.x, v.y)}).`, 'vents', i); });
  }

  return { ok: errors.length === 0, map, errors, warnings, tasks };
}

// Short, stable fingerprint so clients can tell maps apart (not for security).
export function mapHash(json) {
  const s = JSON.stringify(json);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
