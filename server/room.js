// One game room: lobby, authoritative simulation, meetings. All state lives in memory.
// Node runs this on a single thread, so every action is applied one at a time (no locks needed).
import {
  DEFAULT_SETTINGS, COLOR_IDS, HATS, MAX_PLAYERS, MIN_PLAYERS, TICK_HZ, SNAPSHOT_EVERY_TICKS,
  VISION_BASE, BLACKOUT_VISION, RANGE, EMERGENCY_COOLDOWN, SABOTAGE_COOLDOWN, CRISIS_TIME, FIX_HOLD, CORE_HOLD,
  DOOR_LOCK, DOOR_COOLDOWN, RESULT_TIME, RECONNECT_GRACE, TASKS, SABOTAGES, CHAT_MAX, FIX_POINTS, OUTFITS, PETS,
  SPECIAL_ROLES, COLOR_SHADE,
} from '../shared/constants.js';
import { buildMap, stepPlayer, nearestStand, dist, nearestVent, roomAt, roomName, canStand } from '../shared/map.js';
import { LOBBY } from '../shared/lobby.js';
import { validateMap, mapHash } from '../shared/mapcheck.js';
import { checkArt } from '../shared/drawing.js';
import { assignRoles, assignSpecials, assignTasks, tallyVotes, checkWin, stowawayCountFor, clampSetting, cleanName } from '../shared/rules.js';
import { log, newId, newToken } from './util.js';
import { newMotion, queueMoves, earn, drain, resetMotion, isMoving, remember, forgetPath, wasNear } from './motion.js';

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });
const round1 = (n) => Math.round(n * 10) / 10;

export class Room {
  constructor({ code, map, io }) {
    this.code = code;
    this.defaultMap = map;
    this.map = map;
    this.mapJson = null; // set when the host picks a custom map
    this.io = io;
    this.lobbyDirty = true;
    this.debug = false; // a solo test game: never ends by itself (see debugAction)
    this.debugPick = { role: 'crew', special: null };
    this.players = new Map();
    this.hostId = null;
    this.phase = 'lobby'; // lobby → playing ⇄ meeting → result → … → ended → lobby
    this.settings = { ...DEFAULT_SETTINGS };
    this.chat = [];
    this.game = null;
    this.ticks = 0;
    this.lastActive = Date.now();
    this.timer = setInterval(() => this.safeTick(), 1000 / TICK_HZ);
  }

  destroy() { clearInterval(this.timer); }
  get channel() { return `room:${this.code}`; }
  socketOf(p) { return p.socketId ? this.io.sockets.sockets.get(p.socketId) : null; }
  connectedCount() { let n = 0; for (const p of this.players.values()) if (p.connected) n++; return n; }

  // ---------------------------------------------------------------- membership
  addPlayer(socket, { name, hat, color, outfit, pet, art }) {
    if (this.phase !== 'lobby') return fail('That game has already started. Wait for it to finish, then join.');
    if (this.debug && this.players.size >= 1) return fail('That’s a private debug game.');
    if (this.players.size >= MAX_PLAYERS) return fail(`That room is full (${MAX_PLAYERS} players).`);
    const used = new Set([...this.players.values()].map((p) => p.color));
    const colorId = COLOR_IDS.includes(color) && !used.has(color) ? color : COLOR_IDS.find((c) => !used.has(c));
    const p = {
      id: newId(), token: newToken(), name: cleanName(name), hat: HATS.includes(hat) ? hat : 'none', color: colorId,
      outfit: OUTFITS.includes(outfit) ? outfit : 'none', pet: PETS.includes(pet) ? pet : 'none', art: checkArt(art) || {},
      socketId: socket.id, connected: true, disconnectedAt: 0, inGame: false, mv: newMotion(), hist: [],
    };
    this.fixLook(p);
    this.placeInLobby(p, this.players.size);
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.attach(socket, p);
    log('info', 'player_joined', { room: this.code, player: p.id, players: this.players.size });
    this.broadcastState();
    this.io.to(this.channel).emit('look:art', { id: p.id, art: p.art });
    return ok({ you: { id: p.id, token: p.token }, room: this.publicState(), mapJson: this.mapJson, arts: this.allArts() });
  }

  // Drawn hats/outfits/pets only count if the drawing exists.
  fixLook(p) {
    if (p.hat === 'custom' && !p.art.hat) p.hat = 'none';
    if (p.outfit === 'custom' && !p.art.outfit) p.outfit = 'none';
    if (p.pet === 'custom' && !p.art.pet) p.pet = 'none';
  }

  allArts() {
    const out = {};
    for (const q of this.players.values()) if (!q.left && q.art && Object.keys(q.art).length) out[q.id] = q.art;
    return out;
  }

  placeInLobby(p, i) {
    const spot = LOBBY.spawn[i % LOBBY.spawn.length];
    this.teleport(p, spot.x + (Math.random() * 10 - 5), spot.y, true);
    this.lobbyDirty = true;
  }

  attach(socket, p) {
    p.socketId = socket.id;
    p.connected = true;
    // a new connection (maybe a reloaded page) numbers its steps from scratch
    resetMotion(p.mv);
    p.mv.queued = -1; p.mv.last = -1;
    socket.join(this.channel);
    socket.data.code = this.code;
    socket.data.playerId = p.id;
    this.lastActive = Date.now();
  }

  rejoin(socket, token) {
    const p = [...this.players.values()].find((q) => q.token === token);
    if (!p || p.left) return fail('Your seat in that room has gone. Join again from the menu.');
    const old = this.socketOf(p);
    if (old && old.id !== socket.id) { old.data.playerId = null; old.disconnect(true); }
    this.attach(socket, p);
    if (!this.hostId || !this.players.get(this.hostId)?.connected) this.hostId = p.id;
    log('info', 'player_rejoined', { room: this.code, player: p.id });
    this.broadcastState();
    const res = ok({ you: { id: p.id, token: p.token }, room: this.publicState(), mapJson: this.mapJson, arts: this.allArts() });
    if (this.game && p.inGame) {
      res.game = this.privateStart(p);
      if (this.phase === 'meeting') res.meeting = this.publicMeeting();
    }
    return res;
  }

  onDisconnect(socket) {
    const p = this.players.get(socket.data.playerId);
    if (!p || p.socketId !== socket.id) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    p.mv.q.length = 0;
    p.fixHold = null;
    if (this.hostId === p.id) this.reassignHost();
    log('info', 'player_disconnected', { room: this.code, player: p.id });
    this.broadcastState();
  }

  leave(p) {
    const s = this.socketOf(p);
    if (s) { s.leave(this.channel); s.data.code = null; s.data.playerId = null; }
    this.dropPlayer(p, 'left');
  }

  dropPlayer(p, why) {
    if (this.game && p.inGame) {
      p.left = true; p.alive = false; p.connected = false; p.inVent = null;
      this.game.meeting?.votes.delete(p.id);
    } else {
      this.players.delete(p.id);
    }
    if (this.hostId === p.id) this.reassignHost();
    log('info', 'player_dropped', { room: this.code, player: p.id, why });
    this.broadcastState();
    if (this.phase === 'playing') this.winCheck();
  }

  reassignHost() {
    const next = [...this.players.values()].find((q) => q.connected && !q.left);
    this.hostId = next ? next.id : null;
  }

  makeHost(host, targetId) {
    if (host.id !== this.hostId) return fail('Only the host can hand over the host role.');
    const t = this.players.get(targetId);
    if (!t || t.left || !t.connected) return fail('That player is not here.');
    this.hostId = t.id;
    this.broadcastState();
    return ok();
  }

  kick(host, targetId) {
    if (host.id !== this.hostId) return fail('Only the host can remove players.');
    if (this.phase !== 'lobby') return fail('You can only remove players in the lobby.');
    const t = this.players.get(targetId);
    if (!t || t.id === host.id) return fail('That player is not in the room.');
    this.socketOf(t)?.emit('kicked', { message: 'The host removed you from the room.' });
    this.leave(t);
    return ok();
  }

  // ---------------------------------------------------------------- lobby
  publicState() {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      players: [...this.players.values()].filter((p) => !p.left).map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat, outfit: p.outfit, pet: p.pet, connected: p.connected })),
      chat: this.chat.slice(-30),
      map: this.mapInfo(),
      debug: this.debug || undefined,
    };
  }

  mapInfo() {
    return { name: this.map.name, custom: !!this.mapJson, hash: this.mapJson ? mapHash(this.mapJson) : 'kestrel', tasks: this.map.tasks.length, sabotages: this.map.sabotages.length };
  }

  // json = a custom map, or null for the built-in station.
  setMap(p, json) {
    if (p.id !== this.hostId) return fail('Only the host can change the map.');
    if (this.phase !== 'lobby') return fail('You can change the map in the lobby.');
    if (json === null) {
      this.map = this.defaultMap; this.mapJson = null;
    } else {
      const res = validateMap(json);
      if (!res.ok) return fail(`That map has a problem: ${res.errors[0].msg}`);
      this.map = buildMap(res.map); this.mapJson = res.map;
    }
    this.io.to(this.channel).emit('room:map', { mapJson: this.mapJson });
    this.broadcastState();
    log('info', 'map_changed', { room: this.code, custom: !!this.mapJson, name: this.map.name });
    return ok();
  }

  broadcastState() { this.io.to(this.channel).emit('room:state', this.publicState()); }

  updateSettings(p, patch) {
    if (p.id !== this.hostId) return fail('Only the host can change settings.');
    if (this.phase !== 'lobby') return fail('Settings are locked during a game.');
    for (const [k, val] of Object.entries(patch)) {
      const clean = clampSetting(k, val);
      if (clean !== undefined) this.settings[k] = clean;
    }
    this.broadcastState();
    return ok();
  }

  setLook(p, { color, hat, outfit, pet, art }) {
    if (this.phase !== 'lobby') return fail('You can change your look in the lobby.');
    if (color !== undefined) {
      if (!COLOR_IDS.includes(color)) return fail('Unknown colour.');
      if ([...this.players.values()].some((q) => q.id !== p.id && q.color === color)) return fail('Someone already has that colour.');
      p.color = color;
    }
    if (art !== undefined) {
      const clean = checkArt(art);
      if (!clean) return fail('That drawing couldn’t be used. Try drawing it again.');
      p.art = clean;
      this.io.to(this.channel).emit('look:art', { id: p.id, art: p.art });
    }
    if (hat !== undefined && HATS.includes(hat)) p.hat = hat;
    if (outfit !== undefined && OUTFITS.includes(outfit)) p.outfit = outfit;
    if (pet !== undefined && PETS.includes(pet)) p.pet = pet;
    this.fixLook(p);
    this.broadcastState();
    return ok();
  }

  sendChat(p, text) {
    const clean = String(text).replace(/[\u0000-\u001f]/g, '').trim().slice(0, CHAT_MAX);
    if (!clean) return fail('Type a message first.');
    const msg = { from: p.id, name: p.name, color: p.color, text: clean, at: Date.now() };
    if (this.phase === 'lobby' || this.phase === 'ended') {
      this.chat.push(msg);
      if (this.chat.length > 60) this.chat.shift();
      this.io.to(this.channel).emit('chat', msg);
      return ok();
    }
    if (this.phase === 'meeting' || this.phase === 'result') {
      if (p.alive) { this.io.to(this.channel).emit('chat', msg); return ok(); }
      msg.ghost = true; // ghosts only talk to ghosts
      for (const q of this.players.values()) if (q.inGame && !q.alive) this.socketOf(q)?.emit('chat', msg);
      return ok();
    }
    return fail('Chat opens during meetings.');
  }

  // ---------------------------------------------------------------- game start
  start(p) {
    if (p.id !== this.hostId) return fail('Only the host can start the game.');
    if (this.phase !== 'lobby') return fail('The game is already running.');
    for (const q of [...this.players.values()]) if (!q.connected) this.players.delete(q.id);
    const ids = [...this.players.keys()];
    const min = this.settings.smallGames || this.debug ? 1 : MIN_PLAYERS;
    if (ids.length < min) return fail(`You need at least ${MIN_PLAYERS} players. Turn on "Small test games" to try it with fewer.`);

    const now = Date.now();
    let stowaways = stowawayCountFor(ids.length, this.settings.stowaways, this.settings.smallGames);
    let roles = assignRoles(ids, stowaways);
    let specials = assignSpecials(ids.map((id) => ({ id, team: roles.get(id) })), this.settings);
    if (this.debug) { // the debug menu picks your role
      const pick = this.debugPick;
      roles = new Map(ids.map((id) => [id, pick.role]));
      specials = new Map(pick.special ? ids.map((id) => [id, pick.special]) : []);
      stowaways = pick.role === 'stowaway' ? 1 : 0;
    }
    const st = this.settings;
    this.game = {
      startedAt: now,
      stowawaysAtStart: stowaways,
      doorCode: String(Math.floor(1000 + Math.random() * 9000)),
      bodies: [],
      lockedDoors: new Map(),
      doorCooldown: {},
      sabotage: null,
      sabotageReadyAt: now + 10_000,
      emergencyReadyAt: now + EMERGENCY_COOLDOWN * 1000,
      meeting: null,
      result: null,
    };
    ids.forEach((id, i) => {
      const q = this.players.get(id);
      const spot = this.map.spawn[i % this.map.spawn.length];
      Object.assign(q, {
        inGame: true, left: false, role: roles.get(id), alive: true, tasks: assignTasks(this.settings, Math.random, this.map.tasks),
        moving: false,
        cooldownUntil: now + this.settings.cooldown * 1000, emergencyLeft: this.settings.meetings,
        inVent: null, fixHold: null, taskOpen: null,
        // Roles Galore state (only the fields for the player's own role matter)
        special: specials.get(id) || null,
        shotsLeft: st.sheriffShots, shootReadyAt: now + st.sheriffCooldown * 1000,
        fixesLeft: st.engineerFixes,
        shieldId: null, shieldUsedRound: false,
        judgeUses: st.judgeUses,
        inspected: new Map(),
        shiftAs: null, shiftUntil: 0, shiftReadyAt: now + 10_000,
        cleanReadyAt: now + 10_000,
      });
      if (q.special === 'mayor') q.emergencyLeft += st.mayorMeetings;
      this.teleport(q, ...nearestStand(this.map, spot.x, spot.y));
    });
    this.phase = 'playing';
    for (const q of this.players.values()) this.socketOf(q)?.emit('game:start', this.privateStart(q));
    log('info', 'game_started', { room: this.code, players: ids.length, stowaways });
    return ok();
  }

  privateStart(p) {
    const players = [...this.players.values()].filter((q) => q.inGame).map((q) => ({ id: q.id, name: q.name, color: q.color, hat: q.hat, outfit: q.outfit, pet: q.pet }));
    const partnerList = p.role === 'stowaway' ? [...this.players.values()].filter((q) => q.inGame && q.role === 'stowaway' && q.id !== p.id) : [];
    return {
      you: {
        id: p.id, role: p.role, special: p.special, alive: p.alive, tasks: p.tasks,
        partners: partnerList.map((q) => q.id),
        partnerSpecials: Object.fromEntries(partnerList.filter((q) => q.special).map((q) => [q.id, q.special])),
        clues: [...(p.inspected?.values() || [])],
      },
      players,
      settings: this.settings,
      stowaways: this.game.stowawaysAtStart,
      phase: this.phase,
    };
  }

  // ---------------------------------------------------------------- tick
  safeTick() {
    try { this.tick(); } catch (err) { log('error', 'tick_failed', { room: this.code, error: err.stack }); }
  }

  tick() {
    const now = Date.now();
    this.ticks++;
    this.sweepDisconnected(now);
    for (const p of this.players.values()) earn(p.mv);
    if (this.phase === 'playing') {
      this.simulate(now, 1 / TICK_HZ);
      if (this.phase === 'playing' && this.ticks % SNAPSHOT_EVERY_TICKS === 0) this.sendSnapshots(now);
    } else if (this.phase === 'lobby') {
      this.lobbyTick(now);
    } else {
      for (const p of this.players.values()) this.runMoves(p, now);
      if (this.phase === 'meeting') this.meetingTick(now);
      else if (this.phase === 'result' && now >= this.game.result.endsAt) this.afterResult(now);
    }
  }

  // ---------------------------------------------------------------- movement (see server/motion.js)
  receiveMoves(p, packet) {
    if (p.left) return;
    queueMoves(p.mv, packet);
  }

  // Runs a player's waiting movement steps. flush = before an action, so the server agrees with
  // where the player was when they pressed the button.
  runMoves(p, now, flush = false) {
    if (flush) this.lockedNow = this.game ? this.lockedSet(now) : null;
    drain(p.mv, (ix, iy) => this.applyStep(p, ix, iy), now, flush);
  }

  applyStep(p, ix, iy) {
    if (!ix && !iy) return false;
    if (this.phase === 'lobby') {
      [p.lx, p.ly] = stepPlayer(LOBBY, p.lx, p.ly, ix, iy);
      return true;
    }
    if (this.phase !== 'playing' || !p.inGame || p.left || p.inVent) return false;
    [p.x, p.y] = stepPlayer(this.map, p.x, p.y, ix, iy, { speed: this.settings.speed, ghost: !p.alive || !!p.noclip, locked: this.lockedNow });
    return true;
  }

  // Moves a player somewhere new (spawn, vent, debug jump). Their client snaps there and
  // starts predicting again; steps sent before the jump are ignored.
  teleport(p, x, y, lobby = false) {
    if (lobby) { p.lx = x; p.ly = y; } else { p.x = x; p.y = y; forgetPath(p); }
    resetMotion(p.mv);
  }

  // Everyone walks around the lobby room. No vision limits here.
  lobbyTick(now) {
    for (const p of this.players.values()) {
      const was = !!p.lmoving;
      if (p.connected) this.runMoves(p, now);
      p.lmoving = p.connected && isMoving(p.mv, now);
      if (p.lmoving || was !== p.lmoving) this.lobbyDirty = true;
    }
    if (this.ticks % SNAPSHOT_EVERY_TICKS !== 0) return;
    if (!this.lobbyDirty && this.ticks % (SNAPSHOT_EVERY_TICKS * 8) !== 0) return;
    this.lobbyDirty = false;
    const list = [];
    for (const p of this.players.values()) if (!p.left) list.push([p.id, round1(p.lx), round1(p.ly), p.lmoving ? 2 : 0]);
    // one message per player: the shared list plus their own exact position and last step run
    for (const p of this.players.values()) {
      if (!p.connected || p.left) continue;
      this.socketOf(p)?.volatile.emit('lobby:snap', { t: now, p: list, me: { x: p.lx, y: p.ly, seq: p.mv.last, e: p.mv.epoch } });
    }
  }

  sweepDisconnected(now) {
    for (const p of [...this.players.values()]) {
      if (!p.connected && !p.left && p.disconnectedAt && now - p.disconnectedAt > RECONNECT_GRACE * 1000) this.dropPlayer(p, 'timeout');
    }
  }

  lockedSet(now) {
    const set = new Set();
    for (const [id, until] of this.game.lockedDoors) {
      if (until > now) set.add(id); else this.game.lockedDoors.delete(id);
    }
    return set;
  }

  simulate(now, dt) {
    const g = this.game;
    for (const p of this.players.values()) if (p.shiftAs && now >= p.shiftUntil) p.shiftAs = null;
    this.lockedNow = this.lockedSet(now);
    for (const p of this.players.values()) {
      if (!p.inGame || p.left) continue;
      this.runMoves(p, now);
      p.moving = !p.inVent && isMoving(p.mv, now);
      if (p.alive) remember(p, now);
      if (p.fixHold) {
        const pt = this.map.fix[p.fixHold];
        if (dist(p.x, p.y, pt.x, pt.y) > RANGE.fix + 10) p.fixHold = null;
      }
    }

    const s = g.sabotage;
    if (!s) return;
    if (SABOTAGES[s.type].crisis && now >= s.endsAt) return this.debug ? this.fixSabotage(now) : this.endGame('stowaways', 'crisis');
    const holders = {};
    for (const p of this.players.values()) {
      if (p.fixHold && p.alive && !p.left) (holders[p.fixHold] ||= new Set()).add(p.id);
    }
    if (s.type === 'core') {
      const a = holders.core_a; const b = holders.core_b;
      const twoPeople = a && b && new Set([...a, ...b]).size >= 2;
      s.coreTime = twoPeople ? s.coreTime + dt : 0;
      if (s.coreTime >= CORE_HOLD) this.fixSabotage(now);
      return;
    }
    for (const pt of FIX_POINTS[s.type]) {
      if (s.done[pt]) continue;
      s.progress[pt] = holders[pt] ? (s.progress[pt] || 0) + dt : 0;
      if (s.progress[pt] >= FIX_HOLD) s.done[pt] = true;
    }
    if (FIX_POINTS[s.type].every((pt) => s.done[pt])) this.fixSabotage(now);
  }

  sendSnapshots(now) {
    for (const p of this.players.values()) {
      if (!p.inGame || !p.connected) continue;
      this.socketOf(p)?.volatile.emit('snap', this.snapshotFor(p, now));
    }
  }

  visionRadius(viewer) {
    if (!viewer.alive) return Infinity;
    const s = this.game.sabotage;
    const mult = viewer.role === 'stowaway' ? this.settings.stowawayVision : this.settings.crewVision;
    const dark = s?.type === 'blackout' && viewer.role === 'crew' ? BLACKOUT_VISION : 1;
    return VISION_BASE * mult * dark;
  }

  snapshotFor(viewer, now) {
    const g = this.game;
    const r = this.visionRadius(viewer) + 24;
    const ghostView = !viewer.alive;
    const players = [];
    for (const p of this.players.values()) {
      if (p.id === viewer.id || !p.inGame || p.left || p.inVent) continue;
      if (!p.alive && !ghostView) continue; // the living never see ghosts
      if (dist(viewer.x, viewer.y, p.x, p.y) > r) continue;
      const entry = [p.id, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, (p.alive ? 1 : 0) | (p.moving ? 2 : 0)];
      if (p.shiftAs && p.alive) entry.push(p.shiftAs); // the Shapeshifter looks like someone else
      players.push(entry);
    }
    const bodies = g.bodies.filter((b) => ghostView || dist(viewer.x, viewer.y, b.x, b.y) <= r).map((b) => [b.id, b.x, b.y, b.color, b.victim || null]);
    const s = g.sabotage;
    const snap = {
      t: now,
      me: {
        x: viewer.x, y: viewer.y, seq: viewer.mv.last, e: viewer.mv.epoch, alive: viewer.alive, vent: viewer.inVent,
        em: viewer.emergencyLeft, emReady: Math.max(0, (g.emergencyReadyAt - now) / 1000),
      },
      p: players,
      b: bodies,
      prog: this.taskProgress(),
      sab: s ? {
        type: s.type, left: s.endsAt ? Math.max(0, (s.endsAt - now) / 1000) : null,
        done: s.done, progress: s.progress, core: s.coreTime,
      } : null,
      doors: [...this.lockedSet(now)],
    };
    this.roleSnapshot(viewer, snap.me, now);
    if (viewer.noclip) snap.me.noclip = true;
    if (viewer.role === 'stowaway') {
      snap.me.cd = Math.max(0, (viewer.cooldownUntil - now) / 1000);
      snap.me.sabCd = Math.max(0, (g.sabotageReadyAt - now) / 1000);
      snap.me.doorCd = Object.fromEntries(Object.entries(g.doorCooldown).map(([room, t]) => [room, Math.max(0, (t - now) / 1000)]));
    }
    return snap;
  }

  // What a player's own role needs on screen.
  roleSnapshot(p, me, now) {
    const st = this.settings;
    const secs = (t) => Math.max(0, (t - now) / 1000);
    if (st.medicShowShield && this.isShielded(p)) me.shielded = true;
    switch (p.special) {
      case 'sheriff': me.shots = p.shotsLeft; me.shootCd = secs(p.shootReadyAt); break;
      case 'engineer': me.fixes = p.fixesLeft; break;
      case 'medic': me.shield = p.shieldId; me.shieldReady = !p.shieldUsedRound; break;
      case 'judge': me.judge = this.judgeStatus(p); break;
      case 'shapeshifter': me.shiftCd = secs(p.shiftReadyAt); me.shiftAs = p.shiftAs; me.shiftLeft = p.shiftAs ? secs(p.shiftUntil) : 0; break;
      case 'janitor': me.cleanCd = secs(p.cleanReadyAt); break;
      default: break;
    }
  }

  isShielded(t) {
    for (const q of this.players.values()) if (q.special === 'medic' && q.inGame && q.alive && !q.left && q.shieldId === t.id) return true;
    return false;
  }

  judgeStatus(p) {
    const done = p.tasks.filter((t) => t.done).length;
    return { done, need: Math.min(this.settings.judgeTasks, p.tasks.length), uses: p.judgeUses };
  }

  taskProgress() {
    let done = 0; let total = 0;
    for (const p of this.players.values()) {
      if (!p.inGame || p.left || p.role !== 'crew') continue;
      total += p.tasks.length;
      done += p.tasks.filter((t) => t.done).length;
    }
    return { done, total };
  }

  winCheck() {
    if (this.debug) return false; // debug games only end from the debug menu
    if (!this.game) return false;
    const players = [...this.players.values()].filter((p) => p.inGame);
    const w = checkWin(players, this.taskProgress(), this.game.stowawaysAtStart);
    if (w) { this.endGame(w.winner, w.reason); return true; }
    return false;
  }

  endGame(winner, reason) {
    this.phase = 'ended';
    for (const p of this.players.values()) resetMotion(p.mv);
    const roles = [...this.players.values()].filter((p) => p.inGame).map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role, special: p.special, alive: p.alive, left: !!p.left }));
    this.io.to(this.channel).emit('game:over', { winner, reason, roles });
    log('info', 'game_over', { room: this.code, winner, reason, minutes: Math.round((Date.now() - this.game.startedAt) / 6000) / 10 });
  }

  backToLobby(p) {
    if (p.id !== this.hostId) return fail('Only the host can bring everyone back to the lobby.');
    if (this.phase !== 'ended') return fail('The game is still running.');
    for (const q of [...this.players.values()]) {
      if (q.left || !q.connected) this.players.delete(q.id);
      else { q.inGame = false; q.role = null; q.tasks = null; q.alive = true; }
    }
    [...this.players.values()].forEach((q, i) => this.placeInLobby(q, i));
    this.game = null;
    this.phase = 'lobby';
    this.broadcastState();
    return ok();
  }

  // ---------------------------------------------------------------- in-game actions
  requirePlaying(p) {
    if (this.phase !== 'playing') return 'That only works while the game is running.';
    if (!p.inGame || p.left) return 'You are not in this game.';
    this.runMoves(p, Date.now(), true); // catch up on steps sent before the button was pressed
    return null;
  }

  // Is t within `range` of p? `seen` = where p's screen showed t when they pressed the button
  // (other players are drawn slightly in the past). It counts if t really was there a moment ago.
  inReach(p, t, range, seen) {
    if (dist(p.x, p.y, t.x, t.y) <= range + 6) return true;
    if (!seen || !Number.isFinite(seen.x) || !Number.isFinite(seen.y)) return false;
    return dist(p.x, p.y, seen.x, seen.y) <= range + 6 && wasNear(t, seen.x, seen.y, 8);
  }

  openTask(p, taskId) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    if (p.role !== 'crew') return fail('Stowaways only pretend to do tasks.');
    const t = p.tasks.find((x) => x.id === taskId && !x.done);
    if (!t) return fail('That task is not on your list.');
    const spot = this.map.taskSpots[TASKS[taskId].stages[t.stage]];
    if (dist(p.x, p.y, spot.x, spot.y) > RANGE.use + 8) return fail('Walk closer to the task first.');
    p.taskOpen = { taskId, stage: t.stage, at: Date.now() };
    return ok({ stage: t.stage, stages: TASKS[taskId].stages.length, data: taskId === 'door_code' ? { code: this.game.doorCode } : {} });
  }

  completeTask(p, taskId) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    const open = p.taskOpen;
    const t = p.tasks.find((x) => x.id === taskId && !x.done);
    if (!open || !t || open.taskId !== taskId || open.stage !== t.stage) return fail('Open the task before finishing it.');
    if (Date.now() - open.at < TASKS[taskId].min * 1000) return fail('That was too quick. Try the task again.');
    const spot = this.map.taskSpots[TASKS[taskId].stages[t.stage]];
    if (dist(p.x, p.y, spot.x, spot.y) > RANGE.use * 1.8) return fail('You walked away from the task.');
    t.stage += 1;
    if (t.stage >= TASKS[taskId].stages.length) t.done = true;
    p.taskOpen = null;
    this.socketOf(p)?.emit('you:tasks', p.tasks);
    this.winCheck();
    return ok({ tasks: p.tasks });
  }

  eliminate(p, targetId, seen) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    if (p.role !== 'stowaway' || !p.alive || p.inVent) return fail('You can’t do that right now.');
    const now = Date.now();
    if (now < p.cooldownUntil) return fail('Eliminate is still cooling down.');
    const t = this.players.get(targetId);
    if (!t || !t.inGame || t.left || !t.alive || t.inVent) return fail('No one is there.');
    if (t.role === 'stowaway') return fail('That’s your partner.');
    if (!this.inReach(p, t, RANGE.eliminate[this.settings.range], seen)) return fail('Get closer first.');
    p.cooldownUntil = now + this.settings.cooldown * 1000;
    if (this.isShielded(t)) return fail('A shield protected them. Your cooldown restarted.');
    this.kill(t, p, 'eliminated');
    log('info', 'eliminated', { room: this.code });
    this.winCheck();
    return ok();
  }

  // Knocks a player out and leaves a body. `killer` is remembered for the Detective.
  kill(victim, killer, reason) {
    Object.assign(victim, { alive: false, taskOpen: null, fixHold: null, inVent: null, shiftAs: null });
    this.game.bodies.push({ id: newId(), x: victim.x, y: victim.y, color: victim.color, victim: victim.id, killerColor: killer.color });
    this.socketOf(victim)?.emit('you:out', { reason });
  }

  // ---------------------------------------------------------------- Roles Galore actions
  roleCheck(p, special) {
    const err = this.requirePlaying(p); if (err) return err;
    if (p.special !== special) return `Only the ${SPECIAL_ROLES[special].name} can do that.`;
    if (!p.alive) return 'You can’t do that as a ghost.';
    if (p.inVent) return 'Climb out of the vent first.';
    return null;
  }

  target(p, targetId, range, seen) {
    const t = this.players.get(targetId);
    if (!t || !t.inGame || t.left || !t.alive || t.inVent || t.id === p.id) return { error: 'No one is there.' };
    if (range && !this.inReach(p, t, range, seen)) return { error: 'Get closer first.' };
    return { t };
  }

  shoot(p, targetId, seen) {
    const err = this.roleCheck(p, 'sheriff'); if (err) return fail(err);
    const now = Date.now();
    if (p.shotsLeft <= 0) return fail('You have no shots left.');
    if (now < p.shootReadyAt) return fail(`You can shoot again in ${Math.ceil((p.shootReadyAt - now) / 1000)} s.`);
    const { t, error } = this.target(p, targetId, RANGE.eliminate[this.settings.range], seen); if (error) return fail(error);
    p.shotsLeft -= 1;
    p.shootReadyAt = now + this.settings.sheriffCooldown * 1000;
    let result;
    if (this.isShielded(t)) result = 'shielded';
    else if (t.role === 'stowaway') { this.kill(t, p, 'shot'); result = 'hit'; }
    else {
      this.kill(p, p, 'misfire');
      if (this.settings.sheriffMisfire === 'both') this.kill(t, p, 'shot');
      result = 'miss';
    }
    log('info', 'sheriff_shot', { room: this.code, result });
    this.winCheck();
    return ok({ result });
  }

  shield(p, targetId, seen) {
    const err = this.roleCheck(p, 'medic'); if (err) return fail(err);
    if (p.shieldUsedRound) return fail('You can move your shield again after the next meeting.');
    let t = p;
    if (targetId && targetId !== p.id) { const r = this.target(p, targetId, RANGE.eliminate.normal, seen); if (r.error) return fail(r.error); t = r.t; }
    else if (!this.settings.medicSelf) return fail('Stand next to someone to shield them.');
    p.shieldId = t.id;
    p.shieldUsedRound = true;
    return ok({ name: t.id === p.id ? 'yourself' : t.name });
  }

  remoteFix(p) {
    const err = this.roleCheck(p, 'engineer'); if (err) return fail(err);
    if (p.fixesLeft <= 0) return fail('You have used your remote fix.');
    if (!this.game.sabotage) return fail('Nothing is broken right now.');
    p.fixesLeft -= 1;
    this.fixSabotage(Date.now());
    return ok();
  }

  inspect(p, bodyId) {
    const err = this.roleCheck(p, 'detective'); if (err) return fail(err);
    const b = this.game.bodies.find((x) => x.id === bodyId);
    if (!b || dist(p.x, p.y, b.x, b.y) > RANGE.report + 6) return fail('Stand next to a body to inspect it.');
    if (!p.inspected.has(b.id)) {
      const victim = this.players.get(b.victim);
      const colour = this.settings.detectiveInfo === 'colour';
      p.inspected.set(b.id, {
        victim: victim?.name || 'Someone', room: roomName(this.map, roomAt(this.map, b.x, b.y)),
        kind: colour ? 'colour' : 'shade', value: colour ? b.killerColor : COLOR_SHADE[b.killerColor],
      });
    }
    return ok({ clue: p.inspected.get(b.id), clues: [...p.inspected.values()] });
  }

  shift(p, targetId) {
    const err = this.roleCheck(p, 'shapeshifter'); if (err) return fail(err);
    const now = Date.now();
    if (p.shiftAs) return fail('You’re already disguised.');
    if (now < p.shiftReadyAt) return fail(`You can shift again in ${Math.ceil((p.shiftReadyAt - now) / 1000)} s.`);
    const { t, error } = this.target(p, targetId, 0); if (error) return fail('Pick someone who’s still in the game.');
    p.shiftAs = t.id;
    p.shiftUntil = now + this.settings.shiftDuration * 1000;
    p.shiftReadyAt = p.shiftUntil + this.settings.shiftCooldown * 1000;
    return ok({ as: t.id });
  }

  clean(p, bodyId) {
    const err = this.roleCheck(p, 'janitor'); if (err) return fail(err);
    const now = Date.now();
    if (now < p.cleanReadyAt) return fail(`You can clean again in ${Math.ceil((p.cleanReadyAt - now) / 1000)} s.`);
    const i = this.game.bodies.findIndex((x) => x.id === bodyId);
    const b = this.game.bodies[i];
    if (!b || dist(p.x, p.y, b.x, b.y) > RANGE.report + 6) return fail('Stand next to a body to clean it up.');
    this.game.bodies.splice(i, 1);
    p.cleanReadyAt = now + this.settings.janitorCooldown * 1000;
    return ok();
  }

  // The Judge ends the meeting and picks the result (a player, or 'skip' for nobody).
  overrule(p, target) {
    if (this.phase !== 'meeting') return fail('You can only overrule during a meeting.');
    if (!p.inGame || p.left || !p.alive) return fail('Only living players can do that.');
    if (p.special !== 'judge') return fail('Only the Judge can overrule.');
    if (p.judgeUses <= 0) return fail('You have used all your overrules.');
    const js = this.judgeStatus(p);
    if (js.done < js.need) return fail(`Finish ${js.need - js.done} more task${js.need - js.done === 1 ? '' : 's'} first.`);
    if (target !== 'skip') {
      const t = this.players.get(target);
      if (!t || !t.inGame || !t.alive || t.left) return fail('You can’t pick that player.');
    }
    p.judgeUses -= 1;
    this.endVoting(Date.now(), { target: target === 'skip' ? null : target, by: p });
    return ok();
  }

  report(p, bodyId) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    if (!p.alive || p.inVent) return fail('You can’t report right now.');
    const b = this.game.bodies.find((x) => x.id === bodyId);
    if (!b || dist(p.x, p.y, b.x, b.y) > RANGE.report + 6) return fail('There’s nothing to report here.');
    this.startMeeting('report', p, b);
    return ok();
  }

  callEmergency(p) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    const g = this.game; const now = Date.now();
    if (!p.alive || p.inVent) return fail('You can’t call a meeting right now.');
    if (p.emergencyLeft <= 0) return fail('You have used all your emergency meetings.');
    if (now < g.emergencyReadyAt) return fail(`The button is ready in ${Math.ceil((g.emergencyReadyAt - now) / 1000)} s.`);
    if (g.sabotage && SABOTAGES[g.sabotage.type].crisis) return fail('Fix the emergency first.');
    const b = this.map.button;
    if (dist(p.x, p.y, b.x, b.y) > RANGE.emergency + 6) return fail(`Walk to the emergency button in ${roomName(this.map, b.room)}.`);
    p.emergencyLeft -= 1;
    this.startMeeting('emergency', p, null);
    return ok();
  }

  vent(p, op, to) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    if ((p.role !== 'stowaway' && p.special !== 'engineer') || !p.alive) return fail('Only stowaways and the Engineer use vents.');
    if (op === 'enter') {
      if (p.inVent) return fail('You’re already in a vent.');
      const v = nearestVent(this.map, p.x, p.y, RANGE.vent + 6);
      if (!v) return fail('Stand on a vent first.');
      Object.assign(p, { inVent: v.id, fixHold: null });
      this.teleport(p, v.x, v.y);
      return ok({ vent: v.id });
    }
    if (!p.inVent) return fail('You’re not in a vent.');
    if (op === 'move') {
      if (!this.map.ventLinks[p.inVent].includes(to)) return fail('That vent isn’t connected.');
      const v = this.map.vents[to];
      p.inVent = v.id;
      this.teleport(p, v.x, v.y);
      return ok({ vent: v.id });
    }
    p.inVent = null;
    return ok({ vent: null });
  }

  sabotage(p, type, room) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    if (p.role !== 'stowaway') return fail('Only stowaways can sabotage.');
    const g = this.game; const now = Date.now();
    if (type === 'doors') {
      const doors = this.map.doorsByRoom[room];
      if (!doors) return fail('That room has no doors.');
      if (now < (g.doorCooldown[room] || 0)) return fail('Those doors are still cooling down.');
      for (const d of doors) g.lockedDoors.set(d.id, now + DOOR_LOCK * 1000);
      g.doorCooldown[room] = now + (DOOR_LOCK + DOOR_COOLDOWN) * 1000;
      return ok();
    }
    if (!SABOTAGES[type]) return fail('Unknown sabotage.');
    if (!this.map.sabotages.includes(type)) return fail('This map can’t have that sabotage.');
    if (g.sabotage) return fail('Something is already broken.');
    if (now < g.sabotageReadyAt) return fail(`Sabotage is ready in ${Math.ceil((g.sabotageReadyAt - now) / 1000)} s.`);
    g.sabotage = { type, startedAt: now, endsAt: SABOTAGES[type].crisis ? now + CRISIS_TIME * 1000 : null, progress: {}, done: {}, coreTime: 0 };
    this.io.to(this.channel).emit('sabotage', { type, on: true });
    log('info', 'sabotage', { room: this.code, type });
    return ok();
  }

  fix(p, point, holding) {
    const err = this.requirePlaying(p); if (err) return fail(err);
    const s = this.game.sabotage;
    const pt = this.map.fix[point];
    if (!s || !pt || pt.sabotage !== s.type) return fail('Nothing to fix there.');
    if (!p.alive || p.inVent) return fail('You can’t fix that right now.');
    if (!holding) { if (p.fixHold === point) p.fixHold = null; return ok(); }
    if (dist(p.x, p.y, pt.x, pt.y) > RANGE.fix + 8) return fail('Walk closer to fix it.');
    p.fixHold = point;
    return ok();
  }

  fixSabotage(now) {
    const type = this.game.sabotage.type;
    this.game.sabotage = null;
    this.game.sabotageReadyAt = now + SABOTAGE_COOLDOWN * 1000;
    for (const p of this.players.values()) p.fixHold = null;
    this.io.to(this.channel).emit('sabotage', { type, on: false });
  }

  // ---------------------------------------------------------------- meetings
  startMeeting(kind, caller, body) {
    const g = this.game; const now = Date.now();
    if (g.sabotage) { g.sabotage = null; g.sabotageReadyAt = now + SABOTAGE_COOLDOWN * 1000; }
    g.lockedDoors.clear();
    for (const p of this.players.values()) { Object.assign(p, { inVent: null, fixHold: null, taskOpen: null, shiftAs: null }); resetMotion(p.mv); }
    const victim = body ? this.players.get(body.victim) : null;
    const discussion = this.settings.discussion;
    g.meeting = {
      kind,
      by: caller.id,
      body: body ? { name: victim?.name, color: body.color, room: roomAt(this.map, body.x, body.y) } : null,
      stage: discussion > 0 ? 'discuss' : 'vote',
      endsAt: now + (discussion > 0 ? discussion : this.settings.voting) * 1000,
      votes: new Map(),
    };
    this.phase = 'meeting';
    this.io.to(this.channel).emit('meeting:start', this.publicMeeting());
    log('info', 'meeting', { room: this.code, kind });
  }

  publicMeeting() {
    const m = this.game.meeting;
    return {
      kind: m.kind, by: m.by, body: m.body, stage: m.stage,
      left: Math.max(0, (m.endsAt - Date.now()) / 1000),
      voted: [...m.votes.keys()],
      alive: [...this.players.values()].filter((p) => p.inGame && p.alive && !p.left).map((p) => p.id),
    };
  }

  meetingTick(now) {
    const m = this.game.meeting;
    if (now < m.endsAt) return;
    if (m.stage === 'discuss') {
      m.stage = 'vote';
      m.endsAt = now + this.settings.voting * 1000;
      this.io.to(this.channel).emit('meeting:update', this.publicMeeting());
    } else {
      this.endVoting(now);
    }
  }

  vote(p, target) {
    if (this.phase !== 'meeting' || this.game.meeting.stage !== 'vote') return fail('Voting hasn’t started.');
    if (!p.inGame || !p.alive || p.left) return fail('Only living players can vote.');
    const m = this.game.meeting;
    if (m.votes.has(p.id)) return fail('You already voted.');
    if (target !== 'skip') {
      const t = this.players.get(target);
      if (!t || !t.inGame || !t.alive || t.left) return fail('You can’t vote for that player.');
    }
    m.votes.set(p.id, target);
    this.io.to(this.channel).emit('meeting:update', this.publicMeeting());
    const voters = [...this.players.values()].filter((q) => q.inGame && q.alive && !q.left && q.connected);
    if (voters.every((q) => m.votes.has(q.id))) this.endVoting(Date.now());
    return ok();
  }

  // forced = { target, by } when the Judge overrules the vote.
  endVoting(now, forced = null) {
    const g = this.game;
    const weights = new Map();
    for (const p of this.players.values()) if (p.special === 'mayor' && p.alive) weights.set(p.id, this.settings.mayorVotes);
    const tally = tallyVotes(g.meeting.votes, weights);
    const { counts } = tally;
    const ejected = forced ? forced.target : tally.ejected;
    const out = ejected ? this.players.get(ejected) : null;
    if (out) out.alive = false;
    const votes = {};
    for (const [voter, target] of g.meeting.votes) (votes[target] ||= []).push(voter);
    const stowLeft = [...this.players.values()].filter((p) => p.inGame && !p.left && p.alive && p.role === 'stowaway').length;
    g.result = {
      ejected: out ? { id: out.id, name: out.name, color: out.color } : null,
      wasStowaway: out && this.settings.confirmEjects ? out.role === 'stowaway' : null,
      stowawaysLeft: this.settings.confirmEjects ? stowLeft : null,
      counts,
      votes: this.settings.anonymousVotes ? null : votes,
      overruled: forced ? { by: this.settings.judgeAnonymous ? null : forced.by.name } : null,
      endsAt: now + RESULT_TIME * 1000,
    };
    g.meeting = null;
    this.phase = 'result';
    const { endsAt, ...pub } = g.result;
    this.io.to(this.channel).emit('meeting:result', pub);
  }

  afterResult(now) {
    const g = this.game;
    g.result = null;
    if (this.winCheck()) return;
    g.bodies = [];
    let i = 0;
    for (const p of this.players.values()) {
      if (!p.inGame || p.left) continue;
      const spot = this.map.spawn[i++ % this.map.spawn.length];
      Object.assign(p, { cooldownUntil: now + this.settings.cooldown * 1000, shieldUsedRound: false });
      this.teleport(p, ...nearestStand(this.map, spot.x, spot.y));
    }
    g.emergencyReadyAt = now + EMERGENCY_COOLDOWN * 1000;
    this.phase = 'playing';
    this.io.to(this.channel).emit('game:resume', {});
  }

  // ---------------------------------------------------------------- debug games
  // Only in a room made with { debug: true }: one player, never ends unless you press End game.
  debugAction(p, action, args = {}) {
    if (!this.debug) return fail('Debug tools only work in a debug game.');
    if (p.id !== this.hostId) return fail('Only the host can use debug tools.');
    const role = args.role === 'stowaway' ? 'stowaway' : 'crew';
    const special = SPECIAL_ROLES[args.special] ? args.special : null;
    const g = this.game; const now = Date.now();
    const inGame = (this.phase === 'playing' || this.phase === 'meeting' || this.phase === 'result') && p.inGame;
    if (action === 'start') {
      if (this.phase !== 'lobby') return fail('The game is already running.');
      this.debugPick = { role, special };
      return this.start(p);
    }
    if (action === 'end') {
      if (!g || this.phase === 'ended') return fail('There’s no game to end.');
      this.endGame('crew', 'debug');
      return ok();
    }
    if (!inGame) return fail('Start a debug game first.');
    switch (action) {
      case 'role': {
        const st = this.settings;
        Object.assign(p, {
          role, special, shotsLeft: st.sheriffShots, shootReadyAt: 0, fixesLeft: st.engineerFixes, shieldId: null, shieldUsedRound: false,
          judgeUses: st.judgeUses, shiftAs: null, shiftReadyAt: 0, cleanReadyAt: 0, cooldownUntil: 0, inVent: null,
        });
        g.stowawaysAtStart = role === 'stowaway' ? 1 : 0;
        this.socketOf(p)?.emit('game:reload', this.privateStart(p));
        return ok();
      }
      case 'tasks':
        for (const t of p.tasks) { t.stage = TASKS[t.id].stages.length; t.done = true; }
        p.taskOpen = null;
        this.socketOf(p)?.emit('you:tasks', p.tasks);
        return ok();
      case 'cooldowns':
        Object.assign(p, { cooldownUntil: 0, shootReadyAt: 0, shiftReadyAt: 0, cleanReadyAt: 0, shieldUsedRound: false });
        p.emergencyLeft = Math.max(p.emergencyLeft, 1); p.shotsLeft = Math.max(p.shotsLeft, 1); p.fixesLeft = Math.max(p.fixesLeft, 1); p.judgeUses = Math.max(p.judgeUses, 1);
        g.sabotageReadyAt = 0; g.emergencyReadyAt = 0; g.doorCooldown = {};
        return ok();
      case 'body': {
        if (this.phase !== 'playing') return fail('Do that while playing.');
        const spots = [[34, 0], [-34, 0], [0, 30], [0, -30], [0, 0]];
        const [dx, dy] = spots.find(([sx, sy]) => canStand(this.map, p.x + sx, p.y + sy)) || [0, 0];
        const others = COLOR_IDS.filter((c) => c !== p.color);
        const color = others[Math.floor(Math.random() * others.length)];
        g.bodies.push({ id: newId(), x: p.x + dx, y: p.y + dy, color, victim: null, killerColor: others[Math.floor(Math.random() * others.length)] });
        return ok();
      }
      case 'meeting':
        if (this.phase !== 'playing') return fail('Do that while playing.');
        this.startMeeting('emergency', p, null);
        return ok();
      case 'sabotage': {
        if (this.phase !== 'playing') return fail('Do that while playing.');
        if (!this.map.sabotages.includes(args.type)) return fail('This map doesn’t have that sabotage.');
        if (g.sabotage) this.fixSabotage(now);
        g.sabotage = { type: args.type, startedAt: now, endsAt: SABOTAGES[args.type].crisis ? now + CRISIS_TIME * 1000 : null, progress: {}, done: {}, coreTime: 0 };
        this.io.to(this.channel).emit('sabotage', { type: args.type, on: true });
        return ok();
      }
      case 'fix':
        if (!g.sabotage) return fail('Nothing is broken.');
        this.fixSabotage(now);
        return ok();
      case 'alive':
        if (p.alive) this.kill(p, p, 'debug');
        else { p.alive = true; g.bodies = g.bodies.filter((b) => b.victim !== p.id); }
        return ok({ alive: p.alive });
      case 'noclip':
        p.noclip = !p.noclip;
        return ok({ noclip: p.noclip });
      case 'teleport': {
        if (this.phase !== 'playing') return fail('Do that while playing.');
        const r = this.map.roomById[args.room];
        if (!r) return fail('Unknown room.');
        let x = r.x + r.w / 2; let y = r.y + r.h / 2;
        if (!canStand(this.map, x, y)) for (let k = 0; k < 40; k++) { const tx = r.x + 12 + Math.random() * (r.w - 24); const ty = r.y + 12 + Math.random() * (r.h - 24); if (canStand(this.map, tx, ty)) { x = tx; y = ty; break; } }
        p.inVent = null;
        this.teleport(p, x, y);
        return ok();
      }
      default:
        return fail('Unknown debug action.');
    }
  }

  lanSummary() {
    const host = this.players.get(this.hostId);
    return { code: this.code, players: this.connectedCount(), phase: this.phase, host: host ? host.name : '' };
  }
}
