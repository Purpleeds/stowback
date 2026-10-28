// Small server helpers: structured logs, input validation, rate limiting.
import crypto from 'node:crypto';

export function log(level, msg, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line); else console.log(line);
}

export const newId = () => crypto.randomBytes(6).toString('hex');
export const newToken = () => crypto.randomBytes(16).toString('hex');

// Validation: return the clean value or undefined. Callers reject undefined.
export const v = {
  str(x, max) { return typeof x === 'string' && x.length <= max ? x : undefined; },
  id(x) { return typeof x === 'string' && /^[a-f0-9]{12}$/.test(x) ? x : undefined; },
  num(x, min, max) { return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : undefined; },
  bool(x) { return typeof x === 'boolean' ? x : undefined; },
  oneOf(x, list) { return list.includes(x) ? x : undefined; },
  obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : undefined; },
};

// Token bucket per socket and action.
export class RateLimiter {
  constructor(ratePerSec, burst) { this.rate = ratePerSec; this.burst = burst; this.tokens = burst; this.at = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
