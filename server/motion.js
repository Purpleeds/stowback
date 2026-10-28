// Server side of movement. Clients don't send "I'm holding right" any more; they send numbered
// steps, each one 1/60 s of walking in a direction. The server runs every step with the same
// function the client used to predict it (shared/map.js stepPlayer) and tells each client the
// last step it ran, so the client can replay the rest on top of the server's answer. No
// rubber-banding, and the server still decides where everyone really is.
import { MOVE_HZ, TICK_HZ } from '../shared/constants.js';

const MAX_QUEUE = 120; // steps waiting to run (2 s); older ones are dropped
const MAX_CREDIT = MOVE_HZ; // a player can run at most 1 s of saved-up steps at once (stops speed hacks)
const FLUSH_DEBT = MOVE_HZ / 4; // before an action, run waiting steps even if that borrows 0.25 s
const HISTORY_MS = 1000; // how far back "where was everyone" goes (for fair eliminate/shoot)

const PER_TICK = MOVE_HZ / TICK_HZ; // steps that fit in one server tick at walking pace

export const newMotion = () => ({
  q: [], last: -1, queued: -1, credits: MOVE_HZ / 4, epoch: 0, movedAt: 0,
  waiting: true, firstAt: 0, arrivals: [], cushion: 3,
});

const int = (x, min, max) => (Number.isInteger(x) && x >= min && x <= max ? x : undefined);

// Checks a 'move' packet: { e: epoch, s: first step number, r: [[ix, iy, count], ...] }.
// ix, iy are the direction in hundredths (-100..100). Returns null if anything is off.
export function parseMoves(p) {
  if (!p || typeof p !== 'object') return null;
  const e = p.e === undefined ? undefined : int(p.e, 0, 1e9);
  const s = int(p.s, 0, 2 ** 40);
  if ((p.e !== undefined && e === undefined) || s === undefined || !Array.isArray(p.r) || p.r.length > 64) return null;
  const runs = [];
  let total = 0;
  for (const run of p.r) {
    if (!Array.isArray(run) || run.length !== 3) return null;
    const ix = int(run[0], -100, 100); const iy = int(run[1], -100, 100); const n = int(run[2], 1, 240);
    if (ix === undefined || iy === undefined || n === undefined) return null;
    total += n;
    if (total > 240) return null;
    runs.push([ix, iy, n]);
  }
  return { e, s, runs };
}

// Adds new steps to the queue. Steps already queued (resent in case a packet was lost) are skipped.
// Steps sent before a teleport (an older epoch) are thrown away.
export function queueMoves(mv, { e, s, runs }, now = Date.now()) {
  if (e !== undefined && e !== mv.epoch) return;
  const before = mv.q.length;
  let seq = s;
  for (const [ix, iy, n] of runs) {
    for (let k = 0; k < n; k++, seq++) {
      if (seq <= mv.queued) continue;
      mv.q.push(seq, ix, iy);
      mv.queued = seq;
    }
  }
  if (mv.q.length === before) return;
  if (!before) mv.firstAt = now;
  // How bumpy is this player's connection? The longest gap between packets lately decides
  // how many steps to keep in hand (see drain), between 2 and 8 steps (33-133 ms).
  mv.arrivals.push(now);
  while (mv.arrivals.length > 2 && mv.arrivals[0] < now - 2000) mv.arrivals.shift();
  let gap = 0;
  for (let i = 1; i < mv.arrivals.length; i++) {
    const d = mv.arrivals[i] - mv.arrivals[i - 1];
    if (d < 250) gap = Math.max(gap, d); // longer gaps are the player standing still, not lag
  }
  mv.cushion = Math.min(8, Math.max(2, Math.ceil((gap / 1000) * MOVE_HZ)));
  if (mv.q.length > MAX_QUEUE * 3) mv.q.splice(0, mv.q.length - MAX_QUEUE * 3);
}

// Called every server tick: real time passing earns the right to run steps.
export function earn(mv) { mv.credits = Math.min(MAX_CREDIT, mv.credits + MOVE_HZ / TICK_HZ); }

// Runs waiting steps. apply(ix, iy) moves the player and returns true if they moved.
//
// Steps run at a steady walking pace (2 per tick), not in bursts whenever a packet happens to
// arrive, so other players see you move smoothly. When you start walking, a couple of steps are
// kept in hand first, so one late packet doesn't make you stutter on everyone else's screen.
// A backlog (after a lag spike) is caught up gradually. Your own screen doesn't wait for any of
// this: it predicts your steps straight away.
//
// flush = true is used just before an action (eliminate, report…): every waiting step runs now,
// so the server agrees with where the player saw themselves when they pressed the button.
export function drain(mv, apply, now, flush = false) {
  const q = mv.q;
  const queued = q.length / 3;
  if (!queued) { mv.waiting = true; return; }
  let budget = queued;
  if (!flush) {
    if (mv.waiting) {
      if (queued < mv.cushion && now - mv.firstAt < (mv.cushion / MOVE_HZ) * 1000) return;
      mv.waiting = false;
    }
    const extra = queued - PER_TICK - mv.cushion; // more in hand than needed: catch up a little faster
    budget = PER_TICK + (extra > 30 ? extra - 4 : extra > 12 ? 2 : extra > 3 ? 1 : 0);
  }
  const floor = flush ? -FLUSH_DEBT : 1;
  let i = 0;
  while (i < q.length && budget > 0 && (flush ? mv.credits > floor : mv.credits >= floor)) {
    mv.last = q[i];
    if (apply(q[i + 1], q[i + 2])) mv.movedAt = now;
    mv.credits -= 1;
    budget -= 1;
    i += 3;
  }
  if (i) q.splice(0, i);
  if (!q.length && !flush) mv.waiting = true;
}

// A teleport (game start, meeting, vent, debug jump): the client starts predicting again from here.
export function resetMotion(mv) {
  mv.epoch += 1;
  mv.q.length = 0;
  mv.queued = Math.max(mv.queued, mv.last);
  mv.waiting = true;
}

export const isMoving = (mv, now) => now - mv.movedAt < 130;

// ---------------------------------------------------------------- position history
// Everyone sees other players about 0.1-0.2 s in the past (that's what makes them move smoothly).
// To be fair, an eliminate or a shot counts if the target was where the shooter saw them.
export function remember(p, now) {
  const h = p.hist || (p.hist = []);
  h.push(now, p.x, p.y);
  while (h.length > 3 && h[0] < now - HISTORY_MS) h.splice(0, 3);
}

export function forgetPath(p) { p.hist = []; }

// Was the player within `tol` map units of (x, y) at some point in the last second?
export function wasNear(p, x, y, tol) {
  const h = p.hist || [];
  const pts = [];
  for (let i = 0; i < h.length; i += 3) pts.push([h[i + 1], h[i + 2]]);
  pts.push([p.x, p.y]);
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[Math.min(i + 1, pts.length - 1)];
    const vx = bx - ax; const vy = by - ay; const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
    if (Math.hypot(ax + vx * t - x, ay + vy * t - y) <= tol) return true;
  }
  return false;
}
