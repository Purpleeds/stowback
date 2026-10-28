// Minimal static file server: no framework needed for a handful of folders.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

// mounts: [[urlPrefix, directory]] checked in order. '/' should be last.
export function createStaticHandler(mounts, singleFiles = {}) {
  const roots = mounts.map(([prefix, dir]) => [prefix, path.resolve(dir)]);
  return function serve(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return false; }
    let file = singleFiles[urlPath];
    if (!file) {
      for (const [prefix, dir] of roots) {
        if (!urlPath.startsWith(prefix)) continue;
        let rel = urlPath.slice(prefix.length);
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        const full = path.resolve(dir, '.' + path.sep + rel);
        if (!full.startsWith(dir + path.sep) && full !== dir) return false; // path traversal guard
        file = full;
        break;
      }
    }
    if (!file) return false;
    let stat;
    try { stat = fs.statSync(file); } catch { return false; }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  };
}
