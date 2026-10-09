'use strict';

// Fabric mods from Modrinth (https://modrinth.com): finds the right build of a
// project for a Minecraft version, plus whatever it needs that it doesn't
// bundle. Modrinth publishes SHA-1s for every file, so downloads are checked.

const fs = require('fs');
const zlib = require('zlib');

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'gceoalexyt-ops/Mcplayerweb (Minecraft web player)' };

// Mod ids that come with the game or the loader rather than from a mod
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric', 'mixinextras']);

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Modrinth: GET ${url} -> ${res.status}`);
  return res.json();
}

const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Game versions a project has a Fabric build for
function fabricGameVersions(project) {
  return cached(`gv:${project}`, 60 * 60 * 1000, async () => {
    const versions = await getJson(`${API}/project/${encodeURIComponent(project)}/version?loaders=${encodeURIComponent('["fabric"]')}`);
    return [...new Set(versions.flatMap((v) => v.game_versions))];
  });
}

// The newest Fabric build of a project for a game version (releases first),
// or null if there is none.
async function buildFor(project, gameVersion) {
  const q = `loaders=${encodeURIComponent('["fabric"]')}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await cached(`v:${project}:${gameVersion}`, 10 * 60 * 1000,
    () => getJson(`${API}/project/${encodeURIComponent(project)}/version?${q}`));
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  if (!v) return null;
  const file = v.files.find((f) => f.primary) || v.files[0];
  return {
    projectId: v.project_id,
    name: v.name,
    version: v.version_number,
    filename: file.filename,
    url: file.url,
    sha1: file.hashes.sha1,
    size: file.size,
    requires: v.dependencies.filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id),
  };
}

// The first entry called `name` in a zip/jar buffer, or null. A minimal
// reader instead of adm-zip, because some merged mod jars contain duplicate
// entry names, which adm-zip rejects and Fabric accepts (it takes the first).
function readZipEntry(buf, name) {
  // End of central directory record (may be followed by a comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdEnd = eocd;
  // ZIP64: the real values are in a separate record found through a locator
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === 0x06064b50) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      cdEnd = z64;
    }
  }
  // Jars with something prepended (e.g. a launcher stub) have shifted offsets
  const shift = Math.max(0, cdEnd - (cdOffset + cdSize));

  let p = cdOffset + shift;
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    let size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (size === 0xffffffff || local === 0xffffffff) {
        // ZIP64 extra field (id 1) holds the 64-bit values that didn't fit
        const usize = buf.readUInt32LE(p + 24);
        let e = p + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
          const id = buf.readUInt16LE(e);
          const len = buf.readUInt16LE(e + 2);
          if (id === 1) {
            let q = e + 4;
            if (usize === 0xffffffff) q += 8;
            if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
            if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(q));
            break;
          }
          e += 4 + len;
        }
      }
      local += shift;
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Parses fabric.mod.json the way Fabric does: it tolerates a byte-order mark,
// // and /* */ comments, and trailing commas, which strict JSON.parse doesn't.
function parseModJson(data) {
  if (!data) return null;
  let text = data.toString('utf8').replace(/^﻿/, '');
  try { return JSON.parse(text); } catch { /* try the lenient way */ }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  text = out.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(text); } catch { return null; }
}

// What a mod jar says it needs and what it provides, bundled jars included
function readModInfo(jarFile) {
  const ids = new Set();
  const depends = new Set();
  const visit = (buf) => {
    let meta;
    try { meta = parseModJson(readZipEntry(buf, 'fabric.mod.json')); } catch { return; }
    if (!meta) return;
    if (meta.id) ids.add(meta.id);
    for (const p of [].concat(meta.provides || [])) ids.add(typeof p === 'string' ? p : p?.id);
    for (const d of Object.keys(meta.depends || {})) depends.add(d);
    for (const j of meta.jars || []) {
      try {
        const nested = readZipEntry(buf, j.file);
        if (nested) visit(nested);
      } catch { /* not a readable jar */ }
    }
  };
  visit(fs.readFileSync(jarFile));
  return { ids, depends };
}

// Mod ids that the given jars need but none of them provide
function missingDependencies(jarFiles) {
  const provided = new Set(BUILTIN);
  const needed = new Set();
  for (const f of jarFiles) {
    const info = readModInfo(f);
    for (const id of info.ids) provided.add(id);
    for (const d of info.depends) needed.add(d);
  }
  return [...needed].filter((d) => !provided.has(d));
}

// Whether a buffer is a zip/jar at all (it has an end-of-central-directory record)
function isZip(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return true;
  }
  return false;
}

// What a jar is: its parsed fabric.mod.json, or which other loader it is for
function inspectJar(buf) {
  let meta = null;
  try { meta = parseModJson(readZipEntry(buf, 'fabric.mod.json')); } catch { /* not readable */ }
  if (meta && meta.id) return { loader: 'fabric', meta };
  if (readZipEntry(buf, 'quilt.mod.json')) return { loader: 'Quilt' };
  if (readZipEntry(buf, 'META-INF/neoforge.mods.toml')) return { loader: 'NeoForge' };
  if (readZipEntry(buf, 'META-INF/mods.toml') || readZipEntry(buf, 'mcmod.info')) return { loader: 'Forge' };
  return { loader: null };
}

module.exports = { fabricGameVersions, buildFor, missingDependencies, inspectJar, isZip };
