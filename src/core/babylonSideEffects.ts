/**
 * Babylon side-effect imports.
 *
 * `@babylonjs/core` is tree-shakeable, which means features that hook into the
 * Scene are *not* registered just because you imported the feature's class.
 * `ShadowGenerator` is the clearest example: its constructor calls a static
 * `_SceneComponentInitialization` hook that **throws** —
 *
 *   ShadowGeneratorSceneComponent needs to be imported before as it contains a
 *   side-effect required by your code.
 *
 * — until the component module has been evaluated. That is a hard boot failure,
 * and because it only happens on the code path that builds a shadow generator,
 * it stayed hidden until the game ran on a machine where `quality.shadows` is
 * true (see the `side-effects.mjs` harness in verify/).
 *
 * This module is imported first by main.ts so every such component is
 * registered before any game code runs. Add to it whenever a warning like the
 * above appears; the full list of components Babylon can complain about lives
 * in `Misc/devTools.js` (`_WarnImport`).
 *
 * Bundlers keep these: the package marks every file as having side effects, so
 * a bare import is not tree-shaken out of a production build.
 */

// Scene component for light shadows (ShadowGenerator / CascadedShadowGenerator).
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';

// Scene picking. Importing `Ray` alone is not enough: the module that adds
// `Scene.pick` / `pickWithRay` / `multiPickWithRay` is this one.
import '@babylonjs/core/Culling/ray';

// Physics engine attach point for `scene.enablePhysics`.
import '@babylonjs/core/Physics/physicsEngineComponent';

export {};
