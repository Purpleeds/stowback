// Creates the HTTP + Socket.IO game server. Used by Render (server/index.js) and the desktop app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { buildMap } from '../shared/map.js';
import { PROTOCOL_VERSION, GAME_VERSION, COLOR_IDS, HATS, OUTFITS, PETS, NAME_MAX, CHAT_MAX, SABOTAGES, MAP_LIMITS } from '../shared/constants.js';
import { ART_LIMITS } from '../shared/drawing.js';
import { RoomManager } from './rooms.js';
import { createStaticHandler } from './static.js';
import { log, v, RateLimiter } from './util.js';
import { parseMoves } from './motion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function socketClientFile() {
  const main = require.resolve('socket.io'); // …/socket.io/dist/index.js
  return path.join(path.dirname(main), '..', 'client-dist', 'socket.io.esm.min.js');
}

export async function createGameServer({ host = '0.0.0.0', port = 3000 } = {}) {
  const startedAt = Date.now();
  const map = buildMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'maps', 'kestrel-station.map.json'), 'utf8')));
  const serveStatic = createStaticHandler(
    [['/shared/', path.join(ROOT, 'shared')], ['/maps/', path.join(ROOT, 'maps')], ['/', path.join(ROOT, 'client')]],
    { '/vendor/socket.io.esm.min.js': socketClientFile() },
  );

  let rooms;
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, version: GAME_VERSION, protocol: PROTOCOL_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000), ...rooms.stats() }));
    }
    if (serveStatic(req, res)) return;
    if (req.url === '/' || req.url === '/index.html') {
      // a server-only install (no client folder): say what this is instead of "Not found"
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Stowaway game server ${GAME_VERSION} is running. Open the Stowaway app and choose Play online.\n`);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const io = new Server(httpServer, { cors: { origin: '*' }, maxHttpBufferSize: Math.max(MAP_LIMITS.bytes, ART_LIMITS.total) + 20_000, pingInterval: 10_000, pingTimeout: 8_000 });
  rooms = new RoomManager({ io, map });
  wireSockets(io, rooms);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => { httpServer.off('error', reject); resolve(); });
  });
  const actualPort = httpServer.address().port;
  log('info', 'server_listening', { host, port: actualPort, version: GAME_VERSION });

  return {
    io, rooms, port: actualPort, httpServer,
    close: () => new Promise((resolve) => { rooms.close(); io.close(); httpServer.close(() => resolve()); }),
  };
}

function wireSockets(io, rooms) {
  io.use((socket, next) => {
    if (socket.handshake.auth?.v !== PROTOCOL_VERSION) return next(new Error('version'));
    next();
  });

  io.on('connection', (socket) => {
    const general = new RateLimiter(40, 80);
    const chatLimit = new RateLimiter(1, 3);
    const inputLimit = new RateLimiter(40, 60);
    const mapLimit = new RateLimiter(0.5, 3);
    const lookLimit = new RateLimiter(1, 4);

    const ctx = () => {
      const room = socket.data.code ? rooms.get(socket.data.code) : null;
      const player = room ? room.players.get(socket.data.playerId) : null;
      return { room, player };
    };

    // Wrap every handler: rate limit, catch errors, always answer the ack.
    const on = (event, fn, { needRoom = true, limiter = general } = {}) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!limiter.take()) return reply({ ok: false, error: 'Slow down a little.' });
        try {
          if (needRoom) {
            const { room, player } = ctx();
            if (!room || !player) return reply({ ok: false, error: 'You are not in a room.' });
            return reply(fn(payload || {}, room, player) || { ok: true });
          }
          return reply(fn(payload || {}) || { ok: true });
        } catch (err) {
          log('error', 'handler_failed', { event, error: err.stack });
          reply({ ok: false, error: 'Something went wrong on the server. Try again.' });
        }
      });
    };

    // Where the player's screen showed their target (players are drawn a moment in the past).
    const seenAt = (p) => (p && typeof p.seen === 'object' && p.seen ? { x: v.num(p.seen.x, -1e5, 1e5), y: v.num(p.seen.y, -1e5, 1e5) } : null);

    const profile = (p) => ({
      name: v.str(p.name, NAME_MAX * 4) ?? 'Player',
      hat: v.oneOf(p.hat, HATS) ?? 'none',
      color: v.oneOf(p.color, COLOR_IDS),
      outfit: v.oneOf(p.outfit, OUTFITS) ?? 'none',
      pet: v.oneOf(p.pet, PETS) ?? 'none',
      art: p.art, // checked by the room (shared/drawing.js)
    });

    on('room:create', (p) => {
      if (socket.data.code) return { ok: false, error: 'Leave your current room first.' };
      const room = rooms.create();
      if (v.bool(p.debug)) room.debug = true; // solo test game (debug menu)
      const res = room.addPlayer(socket, profile(p));
      const player = res.ok && room.players.get(res.you.id);
      if (player && v.obj(p.settings)) room.updateSettings(player, p.settings); // host's saved favourite settings
      if (v.bool(p.isPublic)) room.settings.isPublic = true;
      if (player) res.room = room.publicState();
      return res;
    }, { needRoom: false });

    on('room:join', (p) => {
      if (socket.data.code) return { ok: false, error: 'Leave your current room first.' };
      const code = v.str(p.code, 12);
      const room = code && rooms.get(code);
      if (!room) return { ok: false, error: 'No room has that code. Check it and try again.' };
      return room.addPlayer(socket, profile(p));
    }, { needRoom: false });

    on('room:rejoin', (p) => {
      const room = v.str(p.code, 12) && rooms.get(p.code);
      const token = v.str(p.token, 64);
      if (!room || !token) return { ok: false, error: 'That room has closed.' };
      return room.rejoin(socket, token);
    }, { needRoom: false });

    on('rooms:list', () => ({ ok: true, rooms: rooms.publicRooms() }), { needRoom: false });
    on('ping', () => ({ ok: true }), { needRoom: false });

    on('room:leave', (_, room, player) => { room.leave(player); });
    on('room:settings', (p, room, player) => room.updateSettings(player, v.obj(p.patch) || {}));
    on('room:look', (p, room, player) => room.setLook(player, { color: p.color, hat: p.hat, outfit: p.outfit, pet: p.pet, art: p.art }), { limiter: lookLimit });
    on('room:kick', (p, room, player) => room.kick(player, v.id(p.playerId)));
    on('room:host', (p, room, player) => room.makeHost(player, v.id(p.playerId)));
    on('room:map', (p, room, player) => room.setMap(player, p.mapJson && typeof p.mapJson === 'object' ? p.mapJson : null), { limiter: mapLimit });
    on('room:start', (_, room, player) => room.start(player));
    on('room:lobby', (_, room, player) => room.backToLobby(player));
    on('chat', (p, room, player) => {
      const text = v.str(p.text, CHAT_MAX * 2);
      return text === undefined ? { ok: false, error: 'Message too long.' } : room.sendChat(player, text);
    }, { limiter: chatLimit });

    // Movement steps (see server/motion.js). Sent about 30 times a second while walking.
    on('move', (p, room, player) => {
      const packet = parseMoves(p);
      if (packet) room.receiveMoves(player, packet);
      return { ok: !!packet };
    }, { limiter: inputLimit });

    on('task:open', (p, room, player) => room.openTask(player, v.str(p.taskId, 40)));
    on('task:done', (p, room, player) => room.completeTask(player, v.str(p.taskId, 40)));
    on('act:eliminate', (p, room, player) => room.eliminate(player, v.id(p.targetId), seenAt(p)));
    on('act:report', (p, room, player) => room.report(player, v.id(p.bodyId)));
    on('act:emergency', (_, room, player) => room.callEmergency(player));
    on('act:vent', (p, room, player) => room.vent(player, v.oneOf(p.op, ['enter', 'move', 'exit']), v.str(p.to, 8)));
    on('act:sabotage', (p, room, player) => {
      const type = v.oneOf(p.type, [...Object.keys(SABOTAGES), 'doors']);
      return type ? room.sabotage(player, type, v.str(p.room, 20)) : { ok: false, error: 'Unknown sabotage.' };
    });
    on('act:fix', (p, room, player) => room.fix(player, v.str(p.point, 20), !!p.holding));
    on('vote', (p, room, player) => room.vote(player, p.target === 'skip' ? 'skip' : v.id(p.target)));
    // Roles Galore
    on('role:shoot', (p, room, player) => room.shoot(player, v.id(p.targetId), seenAt(p)));
    on('role:shield', (p, room, player) => room.shield(player, v.id(p.targetId), seenAt(p)));
    on('role:fix', (_, room, player) => room.remoteFix(player));
    on('role:inspect', (p, room, player) => room.inspect(player, v.id(p.bodyId)));
    on('role:shift', (p, room, player) => room.shift(player, v.id(p.targetId)));
    on('role:clean', (p, room, player) => room.clean(player, v.id(p.bodyId)));
    on('debug', (p, room, player) => room.debugAction(player, v.str(p.action, 20), { role: v.str(p.role, 12), special: v.str(p.special, 20), type: v.str(p.type, 12), room: v.str(p.room, 30) }));
    on('role:overrule', (p, room, player) => room.overrule(player, p.target === 'skip' ? 'skip' : v.id(p.target)));

    socket.on('disconnect', () => {
      const { room } = ctx();
      if (room) room.onDisconnect(socket);
    });
  });
}
