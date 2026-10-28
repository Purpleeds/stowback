// Pure game rules. No I/O, no timers: easy to unit test.
import { SETTING_RULES, TASKS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, SPECIAL_ROLES } from './constants.js';

export function maxStowaways(playerCount) {
  return Math.max(1, Math.floor((playerCount - 1) / 3)); // 4–6 → 1, 7–9 → 2, 10 → 3
}

// How many stowaways a game actually gets.
export function stowawayCountFor(playerCount, wanted, smallGames) {
  if (playerCount < 4) return smallGames && playerCount >= 3 ? 1 : 0;
  return Math.min(Math.max(1, wanted), maxStowaways(playerCount));
}

export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function assignRoles(ids, count, rnd = Math.random) {
  const picked = new Set(shuffle(ids, rnd).slice(0, count));
  return new Map(ids.map((id) => [id, picked.has(id) ? 'stowaway' : 'crew']));
}

// Returns a fresh task list: [{ id, stage, done }]. `available` = task ids the map supports.
export function assignTasks(settings, rnd = Math.random, available = Object.keys(TASKS)) {
  const ofKind = (k) => available.filter((id) => TASKS[id]?.kind === k);
  const pick = (k, n) => shuffle(ofKind(k), rnd).slice(0, n);
  return [...pick('common', settings.tasksCommon), ...pick('long', settings.tasksLong), ...pick('short', settings.tasksShort)]
    .map((id) => ({ id, stage: 0, done: false }));
}

// Roles Galore: gives each switched-on role to one random player of the right team.
// players: [{ id, team }]. Returns Map<id, special>. Classic mode gives nobody a role.
export function assignSpecials(players, settings, rnd = Math.random) {
  const out = new Map();
  if (settings.mode !== 'galore') return out;
  for (const team of ['crew', 'stowaway']) {
    const free = shuffle(players.filter((p) => p.team === team).map((p) => p.id), rnd);
    const roles = shuffle(Object.keys(SPECIAL_ROLES).filter((r) => SPECIAL_ROLES[r].team === team && settings[SPECIAL_ROLES[r].key]), rnd);
    for (const r of roles) { if (!free.length) break; out.set(free.pop(), r); }
  }
  return out;
}

// votes: Map<voterId, targetId | 'skip'>; weights: Map<voterId, number> (the Mayor counts extra).
// Returns { counts, ejected }. Ejects only on a clear top vote that isn't "skip".
export function tallyVotes(votes, weights = new Map()) {
  const counts = {};
  for (const [voter, target] of votes) counts[target] = (counts[target] || 0) + (weights.get(voter) || 1);
  let top = null;
  let topN = 0;
  let tie = false;
  for (const [target, n] of Object.entries(counts)) {
    if (n > topN) { top = target; topN = n; tie = false; } else if (n === topN) tie = true;
  }
  const ejected = !top || tie || top === 'skip' ? null : top;
  return { counts, ejected };
}

// players: [{ role, alive, left }]; tasks: { done, total }
export function checkWin(players, tasks, stowawaysAtStart) {
  const inGame = players.filter((p) => !p.left);
  const crewAlive = inGame.filter((p) => p.alive && p.role === 'crew').length;
  const stowAlive = inGame.filter((p) => p.alive && p.role === 'stowaway').length;
  if (tasks.total > 0 && tasks.done >= tasks.total) return { winner: 'crew', reason: 'tasks' };
  if (stowawaysAtStart > 0 && stowAlive === 0) return { winner: 'crew', reason: 'ejected' };
  if (stowAlive > 0 && stowAlive >= crewAlive) return { winner: 'stowaways', reason: 'outnumbered' };
  if (crewAlive === 0 && stowAlive === 0) return { winner: 'stowaways', reason: 'empty' };
  return null;
}

export function makeRoomCode(rnd = Math.random, taken = () => false) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[Math.floor(rnd() * ROOM_CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
  throw new Error('Could not find a free room code');
}

export function normaliseRoomCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

// Returns a valid value for a setting, or undefined if the input is unusable.
export function clampSetting(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule) return undefined;
  if (rule === 'bool') return typeof value === 'boolean' ? value : undefined;
  if (typeof rule[0] === 'string') return rule.includes(value) ? value : undefined;
  const [min, max, step] = rule;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const snapped = Math.round((n - min) / step) * step + min;
  return Math.min(max, Math.max(min, Math.round(snapped * 100) / 100));
}

export function cleanName(input) {
  const s = String(input || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || 'Player';
}
