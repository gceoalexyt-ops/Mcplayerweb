'use strict';

// A small vanilla launcher: downloads the official client, libraries, assets
// and Java runtime straight from Mojang's servers and builds the launch
// command exactly like the official launcher does.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { config } = require('./config');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const JAVA_RUNTIMES = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const ASSET_BASE = 'https://resources.download.minecraft.net';
const LIBRARY_BASE = 'https://libraries.minecraft.net';

const dirs = {
  versions: path.join(config.dataDir, 'versions'),
  libraries: path.join(config.dataDir, 'libraries'),
  assets: path.join(config.dataDir, 'assets'),
  runtimes: path.join(config.dataDir, 'runtimes'),
};

// ---------------------------------------------------------------- helpers

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function fileOk(file, size, sha1, { full = false } = {}) {
  try {
    const st = await fsp.stat(file);
    if (size != null && st.size !== size) return false;
    if (full && sha1) return (await sha1File(file)) === sha1;
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest, { sha1, size } = {}) {
  if (await fileOk(dest, size, sha1)) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== sha1) throw new Error(`Checksum mismatch for ${url}`);
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      return true;
    } catch (err) {
      lastErr = err;
      await fsp.rm(tmp, { force: true });
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function archMatches(arch) {
  if (arch === 'x86') return process.arch === 'ia32';
  if (arch === 'arm64') return process.arch === 'arm64';
  if (arch === 'x86_64' || arch === 'x64') return process.arch === 'x64';
  return true;
}

function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== 'linux') match = false;
      if (rule.os.arch && !archMatches(rule.os.arch)) match = false;
    }
    if (rule.features) {
      for (const [k, v] of Object.entries(rule.features)) {
        if (Boolean(features[k]) !== v) match = false;
      }
    }
    if (match) allowed = rule.action === 'allow';
  }
  return allowed;
}

function mavenPath(name) {
  const [group, artifact, version, classifier] = name.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return path.posix.join(group.replace(/\./g, '/'), artifact, version, file);
}

// ---------------------------------------------------------------- manifest

let manifestCache = null;
async function getManifest() {
  if (manifestCache && Date.now() - manifestCache.at < 10 * 60 * 1000) return manifestCache.data;
  const data = await fetchJson(VERSION_MANIFEST);
  manifestCache = { at: Date.now(), data };
  return data;
}

async function listReleases() {
  const m = await getManifest();
  return {
    latest: m.latest.release,
    versions: m.versions.filter((v) => v.type === 'release').map((v) => v.id),
  };
}

async function loadVersionJson(versionId) {
  const m = await getManifest();
  const entry = m.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Unknown Minecraft version: ${versionId}`);
  const file = path.join(dirs.versions, versionId, `${versionId}.json`);
  await download(entry.url, file, { sha1: entry.sha1 });
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

// ---------------------------------------------------------------- java

async function ensureJava(version, onProgress) {
  if (config.javaPath) return config.javaPath;
  const platform = { x64: 'linux', ia32: 'linux-i386' }[process.arch];
  if (!platform) return 'java'; // Mojang ships no runtime for this CPU; use the system one
  const component = version.javaVersion?.component || 'jre-legacy';
  const all = await fetchJson(JAVA_RUNTIMES);
  const entry = all[platform]?.[component]?.[0];
  if (!entry) throw new Error(`Mojang does not provide Java runtime "${component}" for ${platform}`);

  const root = path.join(dirs.runtimes, component);
  const marker = path.join(root, '.installed');
  const manifestFile = path.join(root, '.manifest.json');
  const javaBin = path.join(root, 'bin', 'java');
  const installed = await fsp.readFile(marker, 'utf8').catch(() => '');

  // Every launch re-checks the installed files against the cached manifest,
  // so a deleted or truncated file is fetched again instead of breaking Java.
  let manifest = null;
  if (installed === entry.manifest.sha1) {
    manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8').catch(() => 'null'));
  }
  if (!manifest) {
    await fsp.rm(marker, { force: true });
    await fsp.rm(manifestFile, { force: true });
    await download(entry.manifest.url, manifestFile, { sha1: entry.manifest.sha1, size: entry.manifest.size });
    manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  }
  const files = Object.entries(manifest.files);
  for (const [rel, f] of files) if (f.type === 'directory') await fsp.mkdir(path.join(root, rel), { recursive: true });
  const toFetch = files.filter(([, f]) => f.type === 'file');
  let done = 0;
  await pool(toFetch, 16, async ([rel, f]) => {
    const dest = path.join(root, rel);
    await download(f.downloads.raw.url, dest, { sha1: f.downloads.raw.sha1, size: f.downloads.raw.size });
    if (f.executable) await fsp.chmod(dest, 0o755);
    onProgress?.({ stage: `Java runtime (${component})`, done: ++done, total: toFetch.length });
  });
  for (const [rel, f] of files) {
    if (f.type !== 'link') continue;
    const link = path.join(root, rel);
    if ((await fsp.readlink(link).catch(() => null)) === f.target) continue;
    await fsp.rm(link, { force: true });
    await fsp.symlink(f.target, link);
  }
  await fsp.writeFile(marker, entry.manifest.sha1);
  return javaBin;
}

// ---------------------------------------------------------------- libraries

function collectLibraries(version) {
  const classpath = [];
  const downloads = [];
  const natives = [];
  for (const lib of version.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;

    const artifact = lib.downloads?.artifact
      || (!lib.natives ? { path: mavenPath(lib.name), url: `${LIBRARY_BASE}/${mavenPath(lib.name)}` } : null);
    if (artifact) {
      const file = path.join(dirs.libraries, artifact.path);
      downloads.push({ url: artifact.url, file, sha1: artifact.sha1, size: artifact.size });
      classpath.push(file);
      // 1.19+ ships LWJGL natives as normal classpath jars ("...:natives-linux")
      if (/:natives-linux/.test(lib.name)) natives.push({ file, exclude: ['META-INF/'] });
    }

    // Pre-1.19 style natives: a separate classifier jar to extract
    const nativeKey = lib.natives?.linux?.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
    const classifier = nativeKey && lib.downloads?.classifiers?.[nativeKey];
    if (classifier) {
      const file = path.join(dirs.libraries, classifier.path);
      downloads.push({ url: classifier.url, file, sha1: classifier.sha1, size: classifier.size });
      natives.push({ file, exclude: lib.extract?.exclude || ['META-INF/'] });
    }
  }
  return { classpath: [...new Set(classpath)], downloads, natives };
}

function extractNatives(natives, nativesDir) {
  fs.mkdirSync(nativesDir, { recursive: true });
  for (const { file, exclude } of natives) {
    const zip = new AdmZip(file);
    for (const e of zip.getEntries()) {
      if (e.isDirectory || exclude.some((x) => e.entryName.startsWith(x))) continue;
      if (!/\.(so|so\.\d+)$/.test(e.entryName)) continue;
      const dest = path.join(nativesDir, path.basename(e.entryName));
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, e.getData());
    }
  }
}

// ---------------------------------------------------------------- assets

async function ensureAssets(version, gameDir, onProgress) {
  const idx = version.assetIndex;
  const indexFile = path.join(dirs.assets, 'indexes', `${idx.id}.json`);
  await download(idx.url, indexFile, { sha1: idx.sha1, size: idx.size });
  const index = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
  const objects = Object.entries(index.objects);
  let done = 0;
  await pool(objects, 24, async ([, o]) => {
    const sub = o.hash.slice(0, 2);
    await download(`${ASSET_BASE}/${sub}/${o.hash}`, path.join(dirs.assets, 'objects', sub, o.hash), { sha1: o.hash, size: o.size });
    done++;
    if (done % 50 === 0 || done === objects.length) onProgress?.({ stage: 'Game assets', done, total: objects.length });
  });

  // Very old versions read assets from a flat folder instead of the object store
  let legacyDir = null;
  if (index.virtual || index.map_to_resources) {
    legacyDir = index.map_to_resources ? path.join(gameDir, 'resources') : path.join(dirs.assets, 'virtual', idx.id);
    for (const [name, o] of objects) {
      const dest = path.join(legacyDir, name);
      if (fs.existsSync(dest)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(dirs.assets, 'objects', o.hash.slice(0, 2), o.hash), dest);
    }
  }
  return legacyDir;
}

// ---------------------------------------------------------------- public API

// Downloads everything needed for `versionId` and returns a launch plan.
async function prepare(versionId, gameDir, onProgress) {
  onProgress?.({ stage: 'Reading version manifest' });
  const version = await loadVersionJson(versionId);
  if (version.inheritsFrom) throw new Error('Only vanilla versions are supported.');

  const javaPath = await ensureJava(version, onProgress);

  const clientJar = path.join(dirs.versions, versionId, `${versionId}.jar`);
  const libs = collectLibraries(version);
  const jobs = [
    { url: version.downloads.client.url, file: clientJar, sha1: version.downloads.client.sha1, size: version.downloads.client.size },
    ...libs.downloads,
  ];
  let logConfig = null;
  if (version.logging?.client?.file) {
    const f = version.logging.client.file;
    logConfig = { file: path.join(dirs.assets, 'log_configs', f.id), argument: version.logging.client.argument };
    jobs.push({ url: f.url, file: logConfig.file, sha1: f.sha1, size: f.size });
  }
  let done = 0;
  await pool(jobs, 12, async (j) => {
    await download(j.url, j.file, j);
    onProgress?.({ stage: 'Game client & libraries', done: ++done, total: jobs.length });
  });

  const nativesDir = path.join(dirs.versions, versionId, 'natives');
  extractNatives(libs.natives, nativesDir);

  await fsp.mkdir(gameDir, { recursive: true });
  const legacyAssetsDir = await ensureAssets(version, gameDir, onProgress);

  return { version, javaPath, classpath: [...libs.classpath, clientJar], nativesDir, logConfig, legacyAssetsDir };
}

// Builds the java command line for a prepared version and a signed-in account.
function buildCommand(plan, { account, gameDir, width, height }) {
  const { version } = plan;
  const vars = {
    auth_player_name: account.profile.name,
    auth_uuid: account.profile.id,
    auth_access_token: account.mcAccessToken,
    auth_session: `token:${account.mcAccessToken}:${account.profile.id}`,
    auth_xuid: '0',
    clientid: config.msClientId,
    user_type: 'msa',
    user_properties: '{}',
    version_name: version.id,
    version_type: version.type,
    game_directory: gameDir,
    assets_root: dirs.assets,
    game_assets: plan.legacyAssetsDir || dirs.assets,
    assets_index_name: version.assetIndex.id,
    natives_directory: plan.nativesDir,
    library_directory: dirs.libraries,
    classpath: plan.classpath.join(':'),
    classpath_separator: ':',
    launcher_name: 'mcplayerweb',
    launcher_version: '1.0',
    resolution_width: String(width),
    resolution_height: String(height),
  };
  const sub = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  const features = { has_custom_resolution: true };

  const expand = (list) => {
    const out = [];
    for (const a of list || []) {
      if (typeof a === 'string') out.push(sub(a));
      else if (rulesAllow(a.rules, features)) out.push(...[].concat(a.value).map(sub));
    }
    return out;
  };

  let jvm;
  let game;
  if (version.arguments) {
    jvm = expand(version.arguments.jvm);
    game = expand(version.arguments.game);
  } else {
    jvm = [`-Djava.library.path=${plan.nativesDir}`, '-cp', vars.classpath];
    game = version.minecraftArguments.split(' ').map(sub);
    game.push('--width', vars.resolution_width, '--height', vars.resolution_height);
  }

  const args = [`-Xmx${config.maxMemoryMb}M`, '-XX:+UseG1GC'];
  if (plan.logConfig) args.push(plan.logConfig.argument.replace('${path}', plan.logConfig.file));
  args.push(...jvm, version.mainClass, ...game);
  return { command: plan.javaPath, args };
}

module.exports = { listReleases, prepare, buildCommand, rulesAllow, mavenPath };
