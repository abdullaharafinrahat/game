#!/usr/bin/env node
/**
 * Asset pipeline:  crass (Git LFS)  ->  optimized GLB  ->  public/assets
 *
 * Why this exists
 * ---------------
 * The source pack is ~130 MB. Almost all of it is uncompressed 4K PNG
 * textures, and the animation clips ship as 29 separate files that are *bare
 * skeletons* (no mesh). Shipping that untouched would mean a 90+ MB download
 * and ~600 MB of VRAM just for the hero character.
 *
 * What it does
 * ------------
 *   1. Downloads each source GLB (cached in .asset-cache/, gitignored).
 *   2. dedup + prune  -> kills duplicated accessors / orphan nodes.
 *   3. textureCompress -> resize to a mobile-sane budget + WebP (normal maps
 *      get a higher quality floor than albedo).
 *   4. Inspects the result: clip duration, whether the clip carries root
 *      motion on the Hips joint, tri/joint counts.
 *   5. Writes public/assets/manifest.json so the runtime never hardcodes URLs.
 *
 * Usage:  npm run assets            (everything)
 *         npm run assets -- --force (ignore cache)
 *         npm run assets -- --only=clips
 */
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

import { SOURCE, CHARACTER, PROPS, CLIPS } from './asset-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.asset-cache');
const PUBLIC = path.join(ROOT, 'public');
const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const url = (file) => SOURCE.base + encodeURIComponent(file).replace(/%2F/g, '/');
const mb = (n) => (n / 1e6).toFixed(2) + ' MB';

async function download(file) {
  await mkdir(CACHE, { recursive: true });
  const dest = path.join(CACHE, file);
  if (!FORCE && existsSync(dest) && (await stat(dest)).size > 1024) return dest;
  const res = await fetch(url(file));
  if (!res.ok) throw new Error(`download failed ${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A Git LFS pointer would be ~130 bytes of text; refuse to silently ship one.
  if (buf.length < 1024 && buf.subarray(0, 40).toString().includes('git-lfs')) {
    throw new Error(`${file} resolved to an LFS pointer — check the media. URL`);
  }
  await writeFile(dest, buf);
  return dest;
}

/** Resize + WebP every texture in the document, normals kept cleaner. */
async function compressTextures(doc, maxTexture, quality) {
  await doc.transform(
    dedup(),
    prune(),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      quality: Math.min(quality + 8, 94),
      resize: [maxTexture, maxTexture],
      slots: /normalTexture|metallicRoughnessTexture/,
    }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      quality,
      resize: [maxTexture, maxTexture],
    }),
    dedup(),
    prune(),
  );
}

function inspectDoc(doc) {
  const root = doc.getRoot();
  let tris = 0;
  let verts = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      verts += prim.getAttribute('POSITION')?.getCount() ?? 0;
      tris += (prim.getIndices()?.getCount() ?? 0) / 3;
    }
  }
  const skins = root.listSkins().map((s) => ({ name: s.getName(), joints: s.listJoints().length }));
  const animations = root.listAnimations().map((a) => {
    let duration = 0;
    for (const sampler of a.listSamplers()) {
      const input = sampler.getInput();
      if (!input) continue;
      const max = new Float32Array(input.getElementSize());
      try {
        input.getMax(max);
        if (Number.isFinite(max[0])) {
          duration = Math.max(duration, max[0]);
          continue;
        }
      } catch {
        /* fall through to raw array */
      }
      const arr = input.getArray();
      if (arr && arr.length) duration = Math.max(duration, arr[arr.length - 1]);
    }
    return { name: a.getName(), channels: a.listChannels().length, duration };
  });
  // Root motion: Mixamo puts *some* translation on the Hips joint in every
  // clip, so presence alone is not a signal. What matters is whether the hips
  // travel horizontally across the clip — that is the drifting-away-from-origin
  // locomotion the gameplay code has to strip (it drives the transform itself).
  // These rigs are NOT Y-up in armature space: they come out of a Blender/Mixamo
  // export where the Hips rest offset (~98 units = hip height) sits on Z and
  // the Armature node carries a 0.01 scale + rotation to fix it up. So instead
  // of assuming axes we derive them: the axis holding the big rest offset is
  // "up", the other two are the ground plane.
  const armature = root.listNodes().find((n) => /armature/i.test(n.getName()));
  const unitToMeters = armature ? Math.abs(armature.getScale()[0]) || 1 : 1;
  // Exact up axis: rotate world-up (0,1,0) by the inverse of the armature's
  // rotation. That is the axis a Hips translation key moves along to go up.
  let upAxis = 2;
  if (armature) {
    // World-up expressed in the armature's local frame: R^T * (0,1,0), which
    // for quaternion (x,y,z,w) is the second row of the rotation matrix.
    const [x, y, z, w] = armature.getRotation();
    const worldUpInLocal = [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)];
    upAxis = worldUpInLocal.map(Math.abs).indexOf(Math.max(...worldUpInLocal.map(Math.abs)));
  }
  let rootMotionDriftUnits = 0;
  let hipsHeightUnits = 0;

  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const target = ch.getTargetNode()?.getName() ?? '';
      if (ch.getTargetPath() !== 'translation' || !/Hips$/i.test(target)) continue;
      const arr = ch.getSampler()?.getOutput()?.getArray();
      if (!arr || arr.length < 3) continue;

      const first = [arr[0], arr[1], arr[2]];
      if (!hipsHeightUnits) hipsHeightUnits = Math.abs(first[upAxis]);
      const mn = [Infinity, Infinity, Infinity];
      const mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 2 < arr.length; i += 3) {
        for (let j = 0; j < 3; j++) {
          mn[j] = Math.min(mn[j], arr[i + j]);
          mx[j] = Math.max(mx[j], arr[i + j]);
        }
      }
      const horiz = [0, 1, 2].filter((i) => i !== upAxis).map((i) => mx[i] - mn[i]);
      rootMotionDriftUnits = Math.max(rootMotionDriftUnits, Math.hypot(...horiz));
    }
  }

  const rootMotionDrift = rootMotionDriftUnits * unitToMeters;
  const AXES = ['x', 'y', 'z'];
  return {
    tris: Math.round(tris),
    verts,
    skins,
    animations,
    hipsHeightUnits: Number(hipsHeightUnits.toFixed(3)),
    unitToMeters: Number(unitToMeters.toFixed(6)),
    upAxis: AXES[upAxis],
    // Hip sway alone is a few cm; > 15 cm of ground travel per clip is real
    // root motion, which the runtime strips and re-applies from gameplay code.
    rootMotion: rootMotionDrift > 0.15,
    rootMotionDrift: Number(rootMotionDrift.toFixed(3)),
  };
}

async function processModel({ file, out, maxTexture, quality, name }, kind) {
  const src = await download(file);
  const before = (await stat(src)).size;
  const doc = await io.read(src);
  await compressTextures(doc, maxTexture, quality);
  const outPath = path.join(PUBLIC, out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await io.write(outPath, doc);
  const after = (await stat(outPath)).size;
  const info = inspectDoc(doc);
  console.log(
    `  ${kind.padEnd(6)} ${file.padEnd(34)} ${mb(before).padStart(9)} -> ${mb(after).padStart(9)}` +
      `  tris=${info.tris.toLocaleString()}${info.skins.length ? ` joints=${info.skins[0].joints}` : ''}`,
  );
  return { name, url: out.replace(/^assets\//, 'assets/'), bytes: after, bytesSource: before, ...info };
}

async function processClip(clip) {
  const src = await download(clip.file);
  const before = (await stat(src)).size;
  const doc = await io.read(src);
  await doc.transform(dedup(), prune());
  const info = inspectDoc(doc);
  const out = `assets/clips/${clip.name}.glb`;
  const outPath = path.join(PUBLIC, out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await io.write(outPath, doc);
  const after = (await stat(outPath)).size;
  const duration = info.animations[0]?.duration ?? 0;
  console.log(
    `  clip   ${clip.name.padEnd(34)} ${mb(before).padStart(9)} -> ${mb(after).padStart(9)}` +
      `  ${duration.toFixed(2)}s up=${info.upAxis} u=${info.unitToMeters}${info.rootMotion ? ` ROOT-MOTION ${info.rootMotionDrift.toFixed(2)}m` : ''}`,
  );
  return {
    name: clip.name,
    url: out,
    group: clip.group,
    loop: clip.loop && !clip.hold,
    duration: Number(duration.toFixed(3)),
    rootMotion: info.rootMotion,
    rootMotionDrift: info.rootMotionDrift,
    hipsHeightUnits: info.hipsHeightUnits,
    unitToMeters: info.unitToMeters,
    upAxis: info.upAxis,
    bytes: after,
  };
}

async function main() {
  console.log(`\ncrass asset pipeline  (source: github.com/${SOURCE.repo})\n`);
  const t0 = Date.now();

  const character = ONLY === 'all' || ONLY === 'character' ? await processModel(CHARACTER, 'hero') : null;
  const props = ONLY === 'all' || ONLY === 'props' ? [] : null;
  if (props) {
    // battleground first: it is the level the colliders come from.
    const ordered = [...PROPS].sort((a, b) => (a.name === 'battleground' ? -1 : b.name === 'battleground' ? 1 : 0));
    for (const p of ordered) props.push(await processModel(p, 'prop'));
  }
  const clips = ONLY === 'all' || ONLY === 'clips' ? [] : null;
  if (clips) for (const c of CLIPS) clips.push(await processClip(c));

  const manifestPath = path.join(PUBLIC, 'assets/manifest.json');
  const previous = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: { repo: SOURCE.repo, branch: SOURCE.branch, dir: SOURCE.dir },
    character: character ?? previous.character,
    props: props ?? previous.props,
    clips: (clips ?? previous.clips ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const total = (manifest.character?.bytes ?? 0) + (manifest.props ?? []).reduce((a, p) => a + p.bytes, 0) + (manifest.clips ?? []).reduce((a, c) => a + c.bytes, 0);
  const raw = (manifest.character?.bytesSource ?? 0) + (manifest.props ?? []).reduce((a, p) => a + p.bytesSource, 0) + (manifest.clips ?? []).reduce((a, c) => a + c.bytesSource, 0);
  const saved = raw > 0 ? `  (from ${mb(raw)} raw — ${(100 - (total / raw) * 100).toFixed(1)}% smaller)` : '';
  console.log(`\ntotal ${mb(total)}${saved}`);
  console.log(`manifest -> public/assets/manifest.json   [${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
}

main().catch((err) => {
  console.error("\nasset pipeline failed:", err);
  process.exit(1);
});
