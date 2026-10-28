// Keeps every room on this server and closes empty ones.
import { Room } from './room.js';
import { makeRoomCode, normaliseRoomCode } from '../shared/rules.js';
import { ROOM_IDLE_TTL, MAX_PLAYERS } from '../shared/constants.js';
import { log } from './util.js';

export class RoomManager {
  constructor({ io, map }) {
    this.io = io;
    this.map = map;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 30_000);
  }

  create() {
    const code = makeRoomCode(Math.random, (c) => this.rooms.has(c));
    const room = new Room({ code, map: this.map, io: this.io });
    this.rooms.set(code, room);
    log('info', 'room_created', { room: code, rooms: this.rooms.size });
    return room;
  }

  get(code) { return this.rooms.get(normaliseRoomCode(code)); }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.connectedCount() === 0 && now - room.lastActive > ROOM_IDLE_TTL * 1000) {
        room.destroy();
        this.rooms.delete(code);
        log('info', 'room_closed', { room: code, rooms: this.rooms.size });
      } else if (room.connectedCount() > 0) {
        room.lastActive = now;
      }
    }
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter((r) => r.settings.isPublic && r.phase === 'lobby' && r.players.size < MAX_PLAYERS && r.connectedCount() > 0)
      .map((r) => r.lanSummary());
  }

  lanRooms() { return [...this.rooms.values()].filter((r) => r.connectedCount() > 0 && !r.debug).map((r) => r.lanSummary()); }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.connectedCount();
    return { rooms: this.rooms.size, players };
  }

  close() {
    clearInterval(this.sweeper);
    for (const r of this.rooms.values()) r.destroy();
    this.rooms.clear();
  }
}
