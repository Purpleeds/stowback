// LAN discovery over UDP broadcast. The host shouts once a second; joiners listen.
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { LAN_DISCOVERY_PORT, PROTOCOL_VERSION } from '../shared/constants.js';
import { log } from './util.js';

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function broadcastAddress(address, netmask) {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((part, i) => (part | (~m[i] & 255)) & 255).join('.');
}

export class LanBeacon {
  constructor(getInfo) { this.getInfo = getInfo; this.socket = null; this.timer = null; }

  start() {
    if (this.socket) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => log('warn', 'lan_beacon_error', { error: err.message }));
    sock.bind(() => {
      sock.setBroadcast(true);
      this.timer = setInterval(() => this.send(), 1000);
      this.send();
    });
    this.socket = sock;
  }

  send() {
    if (!this.socket) return;
    const msg = Buffer.from(JSON.stringify({ app: 'stowaway', v: PROTOCOL_VERSION, ...this.getInfo() }));
    const targets = new Set(['255.255.255.255', ...lanAddresses().map((a) => broadcastAddress(a.address, a.netmask))]);
    for (const t of targets) this.socket.send(msg, LAN_DISCOVERY_PORT, t, () => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.socket) { try { this.socket.close(); } catch { /* already closed */ } }
    this.socket = null;
  }
}

// Listen for beacons for `ms` milliseconds and return the hosts heard.
export function discover(ms = 2500) {
  return new Promise((resolve) => {
    const hosts = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => { try { sock.close(); } catch { /* closed */ } resolve([...hosts.values()]); };
    sock.on('error', (err) => { log('warn', 'lan_discover_error', { error: err.message }); finish(); });
    sock.on('message', (buf, rinfo) => {
      try {
        const info = JSON.parse(buf.toString());
        if (info.app !== 'stowaway') return;
        hosts.set(`${rinfo.address}:${info.port}`, { address: rinfo.address, ...info });
      } catch { /* ignore junk packets */ }
    });
    sock.bind(LAN_DISCOVERY_PORT, () => setTimeout(finish, ms));
  });
}

// LAN hosting: forward TCP from 0.0.0.0:<listenPort> to the local game server.
// HTTP and WebSockets pass straight through, so LAN players use the exact same server.

export function startTcpForward(listenPort, targetPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      const close = () => { client.destroy(); upstream.destroy(); };
      client.on('error', close);
      upstream.on('error', close);
      client.pipe(upstream).pipe(client);
    });
    server.once('error', reject);
    server.listen(listenPort, '0.0.0.0', () => { server.off('error', reject); resolve(server); });
  });
}
