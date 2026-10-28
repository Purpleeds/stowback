// The lobby is a small walkable room. Players walk around while they wait for the host.
// Art: client/assets/lobby/deck.png (4 px per unit, starts at -20,-20 like the station).
import { buildMap } from './map.js';

export const LOBBY_JSON = {
  format: 'stowaway-map', version: 1, id: 'lobby', name: 'Departure deck', noTable: true,
  size: { w: 400, h: 260 },
  rooms: [{ id: 'deck', name: 'Departure deck', x: 14, y: 70, w: 372, h: 176 }],
  corridors: [],
  doors: [],
  vents: [],
  button: { x: 200, y: 158 },
  spawns: [
    { x: 200, y: 150 }, { x: 160, y: 170 }, { x: 240, y: 170 }, { x: 120, y: 150 }, { x: 280, y: 150 },
    { x: 140, y: 205 }, { x: 260, y: 205 }, { x: 200, y: 215 }, { x: 80, y: 190 }, { x: 320, y: 190 },
  ],
  tasks: [],
  fixes: [],
};

export const LOBBY = buildMap(LOBBY_JSON);

// Things you can walk up to and press Use on.
export const LOBBY_STATIONS = {
  laptop: { x: 72, y: 92, label: 'Laptop · change your look' },
  console: { x: 328, y: 92, label: 'Host console · game settings', hostOnly: true },
};
export const STATION_RANGE = 34;
