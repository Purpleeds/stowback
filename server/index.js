// Entry point for the online server (Render) and local development: `npm start`
import { createGameServer } from './server.js';
import { log } from './util.js';

const port = Number(process.env.PORT) || 3000;

createGameServer({ host: '0.0.0.0', port }).catch((err) => {
  log('error', 'server_start_failed', { error: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (err) => log('error', 'unhandled_rejection', { error: String(err?.stack || err) }));
