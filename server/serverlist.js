'use strict';

// The game's multiplayer server list (servers.dat, uncompressed NBT). Used to
// set "Server Resource Packs: Enabled" on servers, so joining e.g. Hypixel
// accepts its resource pack without the Yes/No prompt.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------------------------------------------------------------- NBT
// Values keep their tag type so the file round-trips unchanged. Strings are
// kept as raw bytes (Java's "modified UTF-8"), so names with emoji survive.

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

function readPayload(buf, p, type) {
  switch (type) {
    case T.BYTE: return [buf.readInt8(p), p + 1];
    case T.SHORT: return [buf.readInt16BE(p), p + 2];
    case T.INT: return [buf.readInt32BE(p), p + 4];
    case T.LONG: return [buf.readBigInt64BE(p), p + 8];
    case T.FLOAT: return [buf.readFloatBE(p), p + 4];
    case T.DOUBLE: return [buf.readDoubleBE(p), p + 8];
    case T.BYTE_ARRAY: { const n = buf.readInt32BE(p); return [Buffer.from(buf.subarray(p + 4, p + 4 + n)), p + 4 + n]; }
    case T.STRING: { const n = buf.readUInt16BE(p); return [Buffer.from(buf.subarray(p + 2, p + 2 + n)), p + 2 + n]; }
    case T.LIST: {
      const itemType = buf.readInt8(p);
      const n = buf.readInt32BE(p + 1);
      let q = p + 5;
      const items = [];
      for (let i = 0; i < n; i++) { const [v, nq] = readPayload(buf, q, itemType); items.push(v); q = nq; }
      return [{ itemType, items }, q];
    }
    case T.COMPOUND: {
      const entries = [];
      let q = p;
      for (;;) {
        const t = buf.readInt8(q);
        if (t === T.END) return [entries, q + 1];
        const n = buf.readUInt16BE(q + 1);
        const name = buf.toString('utf8', q + 3, q + 3 + n);
        const [v, nq] = readPayload(buf, q + 3 + n, t);
        entries.push({ type: t, name, value: v });
        q = nq;
      }
    }
    case T.INT_ARRAY: {
      const n = buf.readInt32BE(p);
      const out = [];
      for (let i = 0; i < n; i++) out.push(buf.readInt32BE(p + 4 + i * 4));
      return [out, p + 4 + n * 4];
    }
    case T.LONG_ARRAY: {
      const n = buf.readInt32BE(p);
      const out = [];
      for (let i = 0; i < n; i++) out.push(buf.readBigInt64BE(p + 4 + i * 8));
      return [out, p + 4 + n * 8];
    }
    default: throw new Error(`Unknown NBT tag ${type}`);
  }
}

function writePayload(type, v, out) {
  const b = (n) => Buffer.alloc(n);
  switch (type) {
    case T.BYTE: { const x = b(1); x.writeInt8(v); out.push(x); break; }
    case T.SHORT: { const x = b(2); x.writeInt16BE(v); out.push(x); break; }
    case T.INT: { const x = b(4); x.writeInt32BE(v); out.push(x); break; }
    case T.LONG: { const x = b(8); x.writeBigInt64BE(v); out.push(x); break; }
    case T.FLOAT: { const x = b(4); x.writeFloatBE(v); out.push(x); break; }
    case T.DOUBLE: { const x = b(8); x.writeDoubleBE(v); out.push(x); break; }
    case T.BYTE_ARRAY: { const x = b(4); x.writeInt32BE(v.length); out.push(x, v); break; }
    case T.STRING: { const x = b(2); x.writeUInt16BE(v.length); out.push(x, v); break; }
    case T.LIST: {
      const x = b(5); x.writeInt8(v.items.length ? v.itemType : T.END); x.writeInt32BE(v.items.length, 1); out.push(x);
      for (const item of v.items) writePayload(v.itemType, item, out);
      break;
    }
    case T.COMPOUND: {
      for (const e of v) {
        const name = Buffer.from(e.name, 'utf8');
        const x = b(3); x.writeInt8(e.type); x.writeUInt16BE(name.length, 1); out.push(x, name);
        writePayload(e.type, e.value, out);
      }
      out.push(Buffer.from([T.END]));
      break;
    }
    case T.INT_ARRAY: { const x = b(4 + v.length * 4); x.writeInt32BE(v.length); v.forEach((n, i) => x.writeInt32BE(n, 4 + i * 4)); out.push(x); break; }
    case T.LONG_ARRAY: { const x = b(4 + v.length * 8); x.writeInt32BE(v.length); v.forEach((n, i) => x.writeBigInt64BE(n, 4 + i * 8)); out.push(x); break; }
    default: throw new Error(`Unknown NBT tag ${type}`);
  }
}

// Root: a named compound
function parse(buf) {
  if (buf.readInt8(0) !== T.COMPOUND) throw new Error('servers.dat does not start with a compound');
  const n = buf.readUInt16BE(1);
  const [root] = readPayload(buf, 3 + n, T.COMPOUND);
  return { rootName: buf.toString('utf8', 3, 3 + n), root };
}

function serialize({ rootName, root }) {
  const name = Buffer.from(rootName, 'utf8');
  const head = Buffer.alloc(3);
  head.writeInt8(T.COMPOUND);
  head.writeUInt16BE(name.length, 1);
  const out = [head, name];
  writePayload(T.COMPOUND, root, out);
  return Buffer.concat(out);
}

const str = (s) => Buffer.from(s, 'utf8'); // ASCII only here, same as modified UTF-8
const get = (compound, name) => compound.find((e) => e.name === name);

// ---------------------------------------------------------------- servers

const HYPIXEL = { name: 'Hypixel', ip: 'mc.hypixel.net' };

// Turns on "Server Resource Packs: Enabled" for every saved server, and adds
// Hypixel once (if the player removes it later, it stays removed).
// Returns a short description of what changed, or null if nothing did.
async function autoAcceptResourcePacks(gameDir) {
  const file = path.join(gameDir, 'servers.dat');
  const marker = path.join(gameDir, '.mcweb-hypixel-added');
  let doc;
  try {
    doc = parse(await fsp.readFile(file));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read servers.dat, left it unchanged (${err.message})`);
    doc = { rootName: '', root: [] };
  }

  let servers = get(doc.root, 'servers');
  if (!servers || servers.type !== T.LIST) {
    servers = { type: T.LIST, name: 'servers', value: { itemType: T.COMPOUND, items: [] } };
    doc.root = doc.root.filter((e) => e.name !== 'servers').concat(servers);
  }
  if (!servers.value.items.length) servers.value.itemType = T.COMPOUND;
  const list = servers.value.items;

  const changes = [];
  if (!fs.existsSync(marker) && !list.some((s) => /(^|\.)hypixel\.net(:\d+)?$/i.test(get(s, 'ip')?.value.toString('utf8') || ''))) {
    list.push([
      { type: T.STRING, name: 'name', value: str(HYPIXEL.name) },
      { type: T.STRING, name: 'ip', value: str(HYPIXEL.ip) },
    ]);
    changes.push('added Hypixel to the server list');
  }

  let switched = 0;
  for (const s of list) {
    const at = get(s, 'acceptTextures');
    if (at && at.type === T.BYTE && at.value === 1) continue;
    if (at) { at.type = T.BYTE; at.value = 1; } else s.push({ type: T.BYTE, name: 'acceptTextures', value: 1 });
    switched++;
  }
  if (switched) changes.push(`resource packs set to Enabled on ${switched} server${switched === 1 ? '' : 's'}`);

  await fsp.mkdir(gameDir, { recursive: true });
  // From now on Hypixel is the player's to keep or remove
  if (!fs.existsSync(marker)) await fsp.writeFile(marker, '');
  if (!changes.length) return null;
  const tmp = `${file}.mcweb.tmp`;
  await fsp.writeFile(tmp, serialize(doc));
  await fsp.rename(tmp, file);
  return changes.join(', ');
}

module.exports = { autoAcceptResourcePacks, parse, serialize };
