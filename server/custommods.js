'use strict';

// Players' own Fabric mods. Uploaded jars are kept per player; each one is
// either loaded when ticked, or pinned to one Minecraft version, where it is
// always loaded (and never on other versions).

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');
const { inspectJar, isZip } = require('./modrinth');

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_MODS = 50;

class ModError extends Error {}

const dirFor = (uuid) => path.join(config.dataDir, 'players', uuid, 'custom-mods');
const indexFor = (uuid) => path.join(dirFor(uuid), 'mods.json');

// One change at a time per player, so concurrent requests can't lose updates
const queues = new Map();
function locked(uuid, fn) {
  const run = (queues.get(uuid) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(uuid, run.catch(() => {}));
  return run;
}

async function load(uuid) {
  try {
    const mods = JSON.parse(await fsp.readFile(indexFor(uuid), 'utf8'));
    return Array.isArray(mods) ? mods : [];
  } catch {
    return [];
  }
}

async function save(uuid, mods) {
  await fsp.mkdir(dirFor(uuid), { recursive: true });
  const tmp = `${indexFor(uuid)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(mods, null, 2));
  await fsp.rename(tmp, indexFor(uuid));
}

// What the browser sees (no server paths)
function publicView(m) {
  const { file, ...rest } = m;
  return rest;
}

function text(v, max = 100) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '';
}

async function list(uuid) {
  return (await load(uuid)).map(publicView);
}

function add(uuid, filename, buf) {
  return locked(uuid, async () => {
    if (!buf?.length) throw new ModError('The file is empty.');
    if (buf.length > MAX_BYTES) throw new ModError('Mods can be at most 100 MB.');
    if (buf.length < 22 || !isZip(buf)) throw new ModError('That is not a .jar file.');

    const kind = inspectJar(buf);
    if (kind.loader !== 'fabric') {
      throw new ModError(kind.loader
        ? `That is a ${kind.loader} mod. Only Fabric mods are supported.`
        : 'That jar is not a Fabric mod (it has no fabric.mod.json).');
    }

    const mods = await load(uuid);
    if (mods.length >= MAX_MODS) throw new ModError(`You can have at most ${MAX_MODS} mods. Remove one first.`);
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const dupe = mods.find((m) => m.sha1 === sha1);
    if (dupe) throw new ModError(`You already added this mod (${dupe.name}).`);

    const { meta } = kind;
    const mc = meta.depends?.minecraft;
    const id = crypto.randomBytes(8).toString('hex');
    const mod = {
      id,
      file: `${id}.jar`,
      filename: text(path.basename(String(filename || 'mod.jar'))) || 'mod.jar',
      name: text(meta.name) || text(meta.id),
      modId: text(meta.id),
      version: text(meta.version, 40),
      minecraft: text(Array.isArray(mc) ? mc.join(' or ') : mc, 60),
      size: buf.length,
      sha1,
      enabled: true,
      alwaysVersion: null,
      addedAt: new Date().toISOString(),
    };
    await fsp.mkdir(dirFor(uuid), { recursive: true });
    await fsp.writeFile(path.join(dirFor(uuid), mod.file), buf);
    mods.push(mod);
    await save(uuid, mods);
    return publicView(mod);
  });
}

function update(uuid, id, changes) {
  return locked(uuid, async () => {
    const mods = await load(uuid);
    const mod = mods.find((m) => m.id === id);
    if (!mod) throw new ModError('That mod is gone. Reload the page.');
    if (typeof changes.enabled === 'boolean') mod.enabled = changes.enabled;
    if (changes.alwaysVersion !== undefined) mod.alwaysVersion = changes.alwaysVersion || null;
    await save(uuid, mods);
    return publicView(mod);
  });
}

function remove(uuid, id) {
  return locked(uuid, async () => {
    const mods = await load(uuid);
    const mod = mods.find((m) => m.id === id);
    if (!mod) return;
    await save(uuid, mods.filter((m) => m !== mod));
    await fsp.rm(path.join(dirFor(uuid), mod.file), { force: true });
  });
}

// Uploads arrive in pieces (so no proxy's request size limit gets in the
// way). Pieces are appended to a temporary file in order; the last one adds
// the finished jar. Returns { received } until then, then the new mod.
const CHUNK_MAX = 8 * 1024 * 1024;

function addChunk(uuid, { uploadId, offset, total, name }, chunk) {
  return locked(`upload:${uuid}`, async () => {
    if (!/^[a-f0-9]{16,64}$/.test(uploadId || '')) throw new ModError('Bad upload id.');
    if (!Number.isInteger(total) || total <= 0) throw new ModError('The file is empty.');
    if (total > MAX_BYTES) throw new ModError('Mods can be at most 100 MB.');
    if (!Number.isInteger(offset) || offset < 0 || !chunk?.length || chunk.length > CHUNK_MAX || offset + chunk.length > total) {
      throw new ModError('Upload got out of step, please try again.');
    }
    const dir = dirFor(uuid);
    const part = path.join(dir, `upload-${uploadId}.part`);
    await fsp.mkdir(dir, { recursive: true });
    if (offset === 0) {
      await cleanStaleParts(dir);
      await fsp.writeFile(part, chunk);
    } else {
      const have = await fsp.stat(part).then((st) => st.size, () => -1);
      if (have !== offset) throw new ModError('Upload got out of step, please try again.');
      await fsp.appendFile(part, chunk);
    }
    if (offset + chunk.length < total) return { received: offset + chunk.length };
    try {
      return await add(uuid, name, await fsp.readFile(part));
    } finally {
      await fsp.rm(part, { force: true });
    }
  });
}

// Leftovers from uploads that were abandoned more than a day ago
async function cleanStaleParts(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  await Promise.all(names.filter((n) => n.endsWith('.part')).map(async (n) => {
    const f = path.join(dir, n);
    const st = await fsp.stat(f).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 24 * 3600 * 1000) await fsp.rm(f, { force: true });
  }));
}

// Jar paths to load when this player starts `versionId`
async function jarsFor(uuid, versionId) {
  const mods = await load(uuid);
  return mods
    .filter((m) => (m.alwaysVersion ? m.alwaysVersion === versionId : m.enabled))
    .map((m) => path.join(dirFor(uuid), m.file));
}

module.exports = { ModError, MAX_BYTES, CHUNK_MAX, list, add, addChunk, update, remove, jarsFor };
