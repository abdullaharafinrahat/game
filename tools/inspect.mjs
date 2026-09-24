#!/usr/bin/env node
/**
 * Debug helper: print rig/scale facts about any asset in .asset-cache (or any
 * path). Handy when a clip looks wrong on the character.
 *
 *   node tools/inspect.mjs character.glb "Idle.glb" "Jump_Forward.glb"
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

for (const arg of process.argv.slice(2)) {
  const file = path.isAbsolute(arg) ? arg : path.join(ROOT, '.asset-cache', arg);
  const doc = await io.read(file);
  const root = doc.getRoot();
  console.log(`\n### ${path.basename(file)}`);

  // Hips rest pose + armature scale tell us the rig's units.
  for (const node of root.listNodes()) {
    if (/(Armature|Hips|mixamorig7)$/i.test(node.getName()) || /Hips$/i.test(node.getName())) {
      console.log(
        `  node ${node.getName().padEnd(22)} t=[${node.getTranslation().map((v) => v.toFixed(3)).join(', ')}]` +
          ` s=[${node.getScale().map((v) => v.toFixed(4)).join(', ')}]`,
      );
    }
  }

  // Mesh extents = the real-world size if the rig is authored in meters.
  const meshes = root.listMeshes();
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const pmin = new Float32Array(pos.getElementSize());
      const pmax = new Float32Array(pos.getElementSize());
      pos.getMin(pmin);
      pos.getMax(pmax);
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], pmin[i]);
        max[i] = Math.max(max[i], pmax[i]);
      }
    }
  }
  if (meshes.length) {
    console.log(`  mesh bbox min=[${min.map((v) => v.toFixed(3)).join(', ')}] max=[${max.map((v) => v.toFixed(3)).join(', ')}]`);
    console.log(`  height=${(max[1] - min[1]).toFixed(3)}  width=${(max[0] - min[0]).toFixed(3)}  depth=${(max[2] - min[2]).toFixed(3)}`);
  }

  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const name = ch.getTargetNode()?.getName() ?? '';
      if (!/Hips$/i.test(name)) continue;
      const arr = ch.getSampler()?.getOutput()?.getArray();
      if (!arr || arr.length < 3) continue;
      if (ch.getTargetPath() === 'translation') {
        let mn = [Infinity, Infinity, Infinity];
        let mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i + 2 < arr.length; i += 3) {
          for (let j = 0; j < 3; j++) {
            mn[j] = Math.min(mn[j], arr[i + j]);
            mx[j] = Math.max(mx[j], arr[i + j]);
          }
        }
        console.log(
          `  [${anim.getName()}] Hips.translation first=[${arr.slice(0, 3).map((v) => v.toFixed(3)).join(', ')}]` +
            ` range=[${mx.map((v, j) => (v - mn[j]).toFixed(3)).join(', ')}]  keys=${arr.length / 3}`,
        );
      }
    }
  }
}
