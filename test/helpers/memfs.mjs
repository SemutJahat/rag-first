// A tiny in-memory filesystem with the node:fs calls lib.mjs uses, so tests stub the disk and the env.
import { dirname, resolve } from 'node:path';

export function memfs(files = {}, { now = Date.now() } = {}) {
  const store = new Map();   // path -> { data: Buffer, mtimeMs } ; directories: { dir: true }
  const fds = new Map();
  let nextFd = 3;
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const mkdirp = (d) => { for (let x = resolve(d); ; x = dirname(x)) { if (!store.has(x)) store.set(x, { dir: true }); if (dirname(x) === x) break; } };
  const put = (p, data, mtimeMs = now) => { p = resolve(p); mkdirp(dirname(p)); store.set(p, { data: Buffer.from(data), mtimeMs }); };
  for (const [p, v] of Object.entries(files)) {
    if (v === null) mkdirp(p);
    else put(p, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v));
  }
  const fs = {
    existsSync: (p) => store.has(resolve(String(p))),
    readFileSync: (p, enc) => { const e = store.get(resolve(p)); if (!e || e.dir) throw enoent(p); return enc ? e.data.toString(enc) : Buffer.from(e.data); },
    writeFileSync: (p, d) => put(p, d),
    appendFileSync: (p, d) => { const e = store.get(resolve(p)); put(p, Buffer.concat([e?.data || Buffer.alloc(0), Buffer.from(d)])); },
    mkdirSync: (p) => mkdirp(p),
    statSync: (p) => { const e = store.get(resolve(p)); if (!e) throw enoent(p); return { size: e.dir ? 0 : e.data.length, mtimeMs: e.mtimeMs ?? now, isDirectory: () => !!e.dir }; },
    renameSync: (a, b) => { const e = store.get(resolve(a)); if (!e) throw enoent(a); store.delete(resolve(a)); mkdirp(dirname(resolve(b))); store.set(resolve(b), e); },
    unlinkSync: (p) => { if (!store.delete(resolve(p))) throw enoent(p); },
    readdirSync: (p) => { const d = resolve(p); if (!store.get(d)?.dir) throw enoent(p); return [...store.keys()].filter((k) => k !== d && dirname(k) === d).map((k) => k.slice(d.length + 1)); },
    realpathSync: (p) => { if (!store.has(resolve(p))) throw enoent(p); return resolve(p); },
    openSync: (p) => { if (!store.has(resolve(p))) throw enoent(p); const fd = nextFd++; fds.set(fd, resolve(p)); return fd; },
    readSync: (fd, buf, off, len, pos) => { const e = store.get(fds.get(fd)); const n = e.data.copy(buf, off, pos, pos + len); return n; },
    closeSync: (fd) => { fds.delete(fd); },
  };
  return { fs, put, store, read: (p) => store.get(resolve(p))?.data?.toString('utf8') };
}
