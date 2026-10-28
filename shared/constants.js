// Shared constants used by both the server and the browser client.
// Plain ES module with no dependencies so it loads in Node and in the browser.

export const GAME_VERSION = '0.5.0';
export const PROTOCOL_VERSION = 5; // bump when client/server messages change

// Player colours (game data). Orange is deliberately absent: it is the UI alert accent.
export const COLORS = {
  red: '#F2545B', blue: '#3D7BFF', green: '#2DB87D', yellow: '#FFC93C',
  berry: '#B4436C', purple: '#8B6CFF', pink: '#FF7AB6', cyan: '#2CC6D6',
  white: '#F7F8FB', brown: '#A8744F', lime: '#A3D94A', black: '#3A3F55',
};
export const COLOR_IDS = Object.keys(COLORS);
// 'custom' = the player's own drawing (see shared/drawing.js)
export const HATS = ['none', 'cap', 'crown', 'leaf', 'band', 'beanie', 'tophat', 'party', 'chef', 'headphones', 'flower', 'pilot', 'custom'];
export const OUTFITS = ['none', 'scarf', 'tie', 'bowtie', 'toolbelt', 'labcoat', 'medal', 'custom'];
export const PETS = ['none', 'drone', 'blob', 'chick', 'rover', 'custom'];
export const COSMETIC_NAMES = {
  none: 'None', cap: 'Cap', crown: 'Crown', leaf: 'Leaf', band: 'Band', beanie: 'Beanie', tophat: 'Top hat', party: 'Party hat',
  chef: 'Chef hat', headphones: 'Headphones', flower: 'Flower', pilot: 'Pilot cap', scarf: 'Scarf', tie: 'Tie', bowtie: 'Bow tie',
  toolbelt: 'Tool belt', labcoat: 'Lab coat', medal: 'Medal', drone: 'Drone', blob: 'Blob', chick: 'Chick', rover: 'Rover',
  custom: 'My drawing',
};

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 4;
export const NAME_MAX = 12;
export const CHAT_MAX = 120;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 6;

// Simulation
export const TICK_HZ = 30;
export const SNAPSHOT_EVERY_TICKS = 2; // 15 snapshots per second
export const BASE_SPEED = 95; // map units per second at speed 1.0
export const MOVE_HZ = 60; // movement steps per second (each step the client sends is 1/60 s of walking)
export const VISION_BASE = 150; // map units at vision 1.0
export const BLACKOUT_VISION = 0.35;

// Interaction ranges (map units)
export const RANGE = {
  use: 36,
  report: 52,
  emergency: 66,
  vent: 26,
  fix: 36,
  eliminate: { short: 32, normal: 45, long: 60 },
};

// Timers (seconds)
export const EMERGENCY_COOLDOWN = 15;
export const SABOTAGE_COOLDOWN = 30;
export const CRISIS_TIME = 40;
export const FIX_HOLD = 2; // seconds of holding Use at a fix point
export const CORE_HOLD = 1; // both reactor pads held together for this long
export const DOOR_LOCK = 10;
export const DOOR_COOLDOWN = 20;
export const RESULT_TIME = 6; // ejection screen
export const RECONNECT_GRACE = 60;
export const ROOM_IDLE_TTL = 300;

export const DEFAULT_SETTINGS = {
  stowaways: 1,
  speed: 1,
  crewVision: 1,
  stowawayVision: 1.5,
  cooldown: 25,
  range: 'normal',
  meetings: 1,
  discussion: 30,
  voting: 60,
  confirmEjects: true,
  anonymousVotes: false,
  tasksCommon: 1,
  tasksLong: 1,
  tasksShort: 3,
  smallGames: false, // lets 1–3 players start, for testing
  isPublic: false,
  // Roles Galore (mode 'galore'): each switched-on role goes to one player
  mode: 'classic',
  roleSheriff: true, roleEngineer: true, roleMedic: true, roleMayor: true, roleJudge: true, roleDetective: true,
  roleShapeshifter: true, roleJanitor: true,
  sheriffCooldown: 25, sheriffShots: 2, sheriffMisfire: 'self',
  engineerFixes: 1,
  medicSelf: false, medicShowShield: true,
  mayorVotes: 2, mayorMeetings: 1,
  judgeTasks: 3, judgeUses: 1, judgeAnonymous: true,
  detectiveInfo: 'shade',
  shiftDuration: 10, shiftCooldown: 30,
  janitorCooldown: 30,
};

// [min, max, step] for numbers, array for choices, 'bool' for toggles
export const SETTING_RULES = {
  stowaways: [1, 3, 1],
  speed: [0.5, 2, 0.25],
  crewVision: [0.5, 2, 0.25],
  stowawayVision: [0.5, 2.5, 0.25],
  cooldown: [10, 60, 5],
  range: ['short', 'normal', 'long'],
  meetings: [0, 3, 1],
  discussion: [0, 90, 15],
  voting: [15, 120, 15],
  confirmEjects: 'bool',
  anonymousVotes: 'bool',
  tasksCommon: [0, 1, 1],
  tasksLong: [0, 3, 1],
  tasksShort: [0, 5, 1],
  smallGames: 'bool',
  isPublic: 'bool',
  mode: ['classic', 'galore'],
  roleSheriff: 'bool', roleEngineer: 'bool', roleMedic: 'bool', roleMayor: 'bool', roleJudge: 'bool', roleDetective: 'bool',
  roleShapeshifter: 'bool', roleJanitor: 'bool',
  sheriffCooldown: [10, 60, 5], sheriffShots: [1, 5, 1], sheriffMisfire: ['self', 'both'],
  engineerFixes: [0, 3, 1],
  medicSelf: 'bool', medicShowShield: 'bool',
  mayorVotes: [2, 3, 1], mayorMeetings: [0, 3, 1],
  judgeTasks: [1, 5, 1], judgeUses: [1, 3, 1], judgeAnonymous: 'bool',
  detectiveInfo: ['shade', 'colour'],
  shiftDuration: [5, 30, 5], shiftCooldown: [10, 60, 5],
  janitorCooldown: [10, 60, 5],
};

// Roles Galore. `team` decides who can get the role; `key` is its on/off setting.
export const SPECIAL_ROLES = {
  sheriff: { name: 'Sheriff', team: 'crew', key: 'roleSheriff', short: 'Shoot someone you suspect. If they’re a stowaway they’re out. If not, you are.' },
  engineer: { name: 'Engineer', team: 'crew', key: 'roleEngineer', short: 'Travel through vents, and fix a sabotage from anywhere.' },
  medic: { name: 'Medic', team: 'crew', key: 'roleMedic', short: 'Shield one player at a time. Shielded players can’t be eliminated.' },
  mayor: { name: 'Mayor', team: 'crew', key: 'roleMayor', short: 'Your vote counts extra, and you get more emergency meetings.' },
  judge: { name: 'Judge', team: 'crew', key: 'roleJudge', short: 'Finish your tasks, then overrule a meeting and decide who is ejected.' },
  detective: { name: 'Detective', team: 'crew', key: 'roleDetective', short: 'Inspect bodies to get a clue about who did it.' },
  shapeshifter: { name: 'Shapeshifter', team: 'stowaway', key: 'roleShapeshifter', short: 'Disguise yourself as another player for a few seconds.' },
  janitor: { name: 'Janitor', team: 'stowaway', key: 'roleJanitor', short: 'Clean up bodies so nobody can report them.' },
};
// For the Detective's clue: is the killer's colour light or dark?
export const COLOR_SHADE = {
  white: 'light', yellow: 'light', lime: 'light', cyan: 'light', pink: 'light', green: 'light',
  red: 'dark', blue: 'dark', berry: 'dark', purple: 'dark', brown: 'dark', black: 'dark',
};

// Ready-made settings the host can pick in the lobby.
export const PRESETS = {
  classic: { name: 'Classic', settings: { ...DEFAULT_SETTINGS } },
  quick: { name: 'Quick', settings: { speed: 1.25, cooldown: 20, discussion: 15, voting: 30, tasksLong: 1, tasksShort: 2 } },
  hard: { name: 'Hard', settings: { crewVision: 0.75, stowawayVision: 1.75, cooldown: 15, range: 'long', confirmEjects: false, anonymousVotes: true, tasksLong: 2, tasksShort: 4 } },
  galore: { name: 'Roles Galore', settings: { mode: 'galore', stowaways: 2 } },
};

// Tasks. `stages` are task-spot ids in the map JSON; a map only gets the tasks whose spots it has.
// `min` is the minimum seconds a task panel must be open before the server accepts it.
export const TASKS = {
  door_code: { name: 'Enter door code', kind: 'common', stages: ['door_code'], min: 1.5 },
  reroute_grid: { name: 'Reroute the grid', kind: 'long', stages: ['reroute_grid_1', 'reroute_grid_2'], min: 2.5 },
  sort_cargo: { name: 'Sort the cargo', kind: 'long', stages: ['sort_cargo'], min: 3 },
  match_cables: { name: 'Match the cables', kind: 'long', stages: ['cables_1', 'cables_2'], min: 1.5 },
  calibrate_thrusters: { name: 'Calibrate thrusters', kind: 'short', stages: ['calibrate_thrusters'], min: 1.5 },
  water_plants: { name: 'Water the plants', kind: 'short', stages: ['water_plants'], min: 1.5 },
  align_dish: { name: 'Align the dish', kind: 'short', stages: ['align_dish'], min: 1.5 },
  scan_badge: { name: 'Scan your badge', kind: 'short', stages: ['scan_badge'], min: 1 },
  clean_filter: { name: 'Clean the filter', kind: 'short', stages: ['clean_filter'], min: 1.5 },
};
// Every task spot a map can have, with a friendly name for the map maker.
export const TASK_SPOTS = {
  door_code: 'Door code keypad', reroute_grid_1: 'Power grid (part 1)', reroute_grid_2: 'Power grid (part 2)', sort_cargo: 'Cargo belt',
  cables_1: 'Cable panel (part 1)', cables_2: 'Cable panel (part 2)', calibrate_thrusters: 'Thruster controls', water_plants: 'Plant pots',
  align_dish: 'Dish dial', scan_badge: 'Badge scanner', clean_filter: 'Air filter',
};

export const SABOTAGES = {
  core: { name: 'Core overload', crisis: true },
  o2: { name: 'O₂ leak', crisis: true },
  blackout: { name: 'Blackout', crisis: false },
  comms: { name: 'Comms jam', crisis: false },
};
// Fix points per sabotage (ids used by server and client). A map only gets the sabotages whose points it has.
export const FIX_POINTS = {
  core: ['core_a', 'core_b'], o2: ['o2_a', 'o2_b'], blackout: ['blackout'], comms: ['comms'],
};
export const FIX_NAMES = {
  core_a: 'Reactor pad A', core_b: 'Reactor pad B', o2_a: 'O₂ keypad A', o2_b: 'O₂ keypad B', blackout: 'Switchboard', comms: 'Comms dish',
};

// Custom maps (see shared/mapcheck.js)
export const MAP_LIMITS = {
  minW: 300, minH: 200, maxW: 1600, maxH: 1000, rooms: 30, corridors: 60, doors: 40, vents: 24, spawns: 10,
  nameMax: 24, roomNameMax: 18, bytes: 64_000, grid: 10,
};

export const LAN_PORT = 7777;
export const LAN_DISCOVERY_PORT = 7778;
export const DESKTOP_UI_PORT = 47777;
