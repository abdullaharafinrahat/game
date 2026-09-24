#!/usr/bin/env node
/**
 * Validates the generated asset manifest and the files it points at, so a
 * broken pipeline run fails loudly here instead of at runtime in the browser.
 *
 *   npm run assets:check
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIPS, PROPS, CHARACTER } from './asset-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST = path.join(PUBLIC, 'assets/manifest.json');

const problems = [];
const notes = [];
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

function expect(condition, message) {
  if (!condition) problems.push(message);
}

if (!existsSync(MANIFEST)) {
  console.error('manifest missing — run `npm run assets` first');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));

// --- structure --------------------------------------------------------------
expect(Boolean(manifest.character), 'manifest.character is missing');
expect(Array.isArray(manifest.props) && manifest.props.length > 0, 'manifest.props is empty');
expect(Array.isArray(manifest.clips) && manifest.clips.length > 0, 'manifest.clips is empty');

// --- every entry has a real file, and the expected shape --------------------
const checkEntry = async (entry, kind) => {
  const file = path.join(PUBLIC, entry.url);
  if (!existsSync(file)) {
    problems.push(`${kind} "${entry.name}" -> missing file ${entry.url}`);
    return;
  }
  const size = (await stat(file)).size;
  expect(size > 1024, `${kind} "${entry.name}" is only ${size} bytes (an LFS pointer?)`);
  expect(size === entry.bytes, `${kind} "${entry.name}" is ${size} bytes but the manifest says ${entry.bytes}`);
  // A GLB starts with the magic `glTF`.
  const head = (await readFile(file)).subarray(0, 4).toString('ascii');
  expect(head === 'glTF', `${kind} "${entry.name}" does not start with the glTF magic`);
};

await checkEntry(manifest.character, 'character');
for (const prop of manifest.props) await checkEntry(prop, 'prop');
for (const clip of manifest.clips) await checkEntry(clip, 'clip');

// --- clips: the manifest must cover the source list, with usable metadata ---
const manifestNames = new Set(manifest.clips.map((c) => c.name));
for (const clip of CLIPS) {
  if (!manifestNames.has(clip.name)) problems.push(`clip "${clip.name}" is in the source manifest but missing from the build`);
}
for (const clip of manifest.clips) {
  expect(clip.duration > 0.05, `clip "${clip.name}" has a suspicious duration of ${clip.duration}s`);
  expect(['x', 'y', 'z'].includes(clip.upAxis), `clip "${clip.name}" has no usable upAxis (got ${clip.upAxis})`);
  expect(clip.unitToMeters > 0, `clip "${clip.name}" has unitToMeters=${clip.unitToMeters}`);
  if (clip.loop) expect(clip.duration < 20, `looping clip "${clip.name}" is ${clip.duration}s — probably not a cycle`);
}

// --- props: the level needs these by name ----------------------------------
for (const required of ['battleground', ...PROPS.filter((p) => p.collider === 'mesh').map((p) => p.name)]) {
  if (!manifest.props.some((p) => p.name === required)) {
    problems.push(`prop "${required}" is required by the level but missing from the build`);
  }
}

// --- character: the rig the clips must bind to ------------------------------
const joints = manifest.character.skins?.[0]?.joints ?? 0;
expect(joints >= 30, `character rig reports ${joints} joints — clips will not bind`);
expect(manifest.character.tris > 1000, `character reports ${manifest.character.tris} triangles`);

// --- size budget -----------------------------------------------------------
const total =
  manifest.character.bytes +
  manifest.props.reduce((a, p) => a + p.bytes, 0) +
  manifest.clips.reduce((a, c) => a + c.bytes, 0);
const source =
  (manifest.character.bytesSource ?? 0) +
  manifest.props.reduce((a, p) => a + (p.bytesSource ?? 0), 0) +
  manifest.clips.reduce((a, c) => a + (c.bytesSource ?? 0), 0);

// Keep the first-load payload in the same order of magnitude as the rest.
const BUDGET = 20e6;
expect(total < BUDGET, `payload is ${mb(total)}, over the ${mb(BUDGET)} budget — check texture budgets`);

notes.push(`${manifest.clips.length} clips (${manifest.clips.filter((c) => c.loop).length} looping, ${manifest.clips.filter((c) => c.rootMotion).length} with measured root motion)`);
notes.push(`${manifest.props.length} props, character ${manifest.character.tris.toLocaleString()} tris / ${joints} joints`);
notes.push(`payload ${mb(total)}${source ? ` from ${mb(source)} source (${(100 - (total / source) * 100).toFixed(1)}% smaller)` : ''}`);

console.log('\nasset check');
for (const note of notes) console.log(`  ${note}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  x ${problem}`);
  process.exit(1);
}
console.log('\n  ok — manifest, files and metadata all consistent\n');
