// ---------------------------------------------------------------------------
// Which source assets we pull from abdullaharafinrahat/crass (Git LFS) and how
// hard we squeeze them. Texture budget is the whole game here: the raw
// character.glb is 91 MB and ~89 MB of that is six 4K PNGs.
// ---------------------------------------------------------------------------

export const SOURCE = {
  repo: 'abdullaharafinrahat/crass',
  branch: 'master',
  dir: 'optimized_assets',
  // media.* serves the real LFS bytes with `Access-Control-Allow-Origin: *`.
  base: 'https://media.githubusercontent.com/media/abdullaharafinrahat/crass/master/optimized_assets/',
};

/** Skinned hero character: 65-joint Mixamo rig, no animation clips inside. */
export const CHARACTER = {
  file: 'character.glb',
  out: 'assets/character.glb',
  maxTexture: 1024,
  quality: 82,
};

/** Static level geometry + weapons. Physics colliders are built from these. */
export const PROPS = [
  { file: 'battleground.glb', name: 'battleground', out: 'assets/props/battleground.glb', maxTexture: 1024, quality: 80, collider: 'mesh' },
  { file: 'house.glb', name: 'house', out: 'assets/props/house.glb', maxTexture: 1024, quality: 80, collider: 'mesh' },
  { file: 'house_1.glb', name: 'house_1', out: 'assets/props/house_1.glb', maxTexture: 1024, quality: 80, collider: 'mesh' },
  { file: 'house_2.glb', name: 'house_2', out: 'assets/props/house_2.glb', maxTexture: 1024, quality: 80, collider: 'mesh' },
  { file: 'HOUSE2.glb', name: 'house_big', out: 'assets/props/house_big.glb', maxTexture: 1024, quality: 80, collider: 'mesh' },
  { file: 'weapon_sniper.glb', name: 'sniper', out: 'assets/props/sniper.glb', maxTexture: 1024, quality: 84, collider: 'none' },
];

/**
 * Animation-only GLBs. Every one of them is a bare `Armature` node tree (65
 * joints, same `mixamorig7:` names as the character) plus one Mixamo clip, so
 * they retarget onto the hero skeleton at runtime by bone name.
 *
 * `loop` and `rootMotion` are gameplay hints; the pipeline computes the real
 * clip duration and whether the Hips joint carries a translation track.
 */
export const CLIPS = [
  { file: 'Idle.glb', name: 'Idle', loop: true, group: 'locomotion' },
  { file: 'Idle To Running.glb', name: 'IdleToRun', loop: false, group: 'locomotion' },
  { file: 'Walking.glb', name: 'Walk', loop: true, group: 'locomotion' },
  { file: 'Walk Forward Left.glb', name: 'WalkForwardLeft', loop: true, group: 'locomotion' },
  { file: 'ImageToStl.com_Walk+Forward+Right.glb', name: 'WalkForwardRight', loop: true, group: 'locomotion' },
  { file: 'Running.glb', name: 'Run', loop: true, group: 'locomotion' },
  { file: 'Sprint Forward.glb', name: 'Sprint', loop: true, group: 'locomotion' },
  { file: 'spirint.glb', name: 'SprintAlt', loop: true, group: 'locomotion' },
  { file: 'Jump_Forward.glb', name: 'Jump', loop: false, group: 'locomotion' },

  { file: 'Rifle_Idle.glb', name: 'RifleIdle', loop: true, group: 'rifle' },
  { file: 'Rifle Idle.glb', name: 'RifleIdleAlt', loop: true, group: 'rifle' },
  { file: 'Rifle Aim To Down.glb', name: 'RifleAimToDown', loop: false, group: 'rifle' },
  { file: 'Walk With Rifle.glb', name: 'RifleWalk', loop: true, group: 'rifle' },
  { file: 'rifle_walk.glb', name: 'RifleWalkAlt', loop: true, group: 'rifle' },
  { file: 'Rifle Run (1).glb', name: 'RifleRun', loop: true, group: 'rifle' },
  { file: 'rifle_run.glb', name: 'RifleRunAlt', loop: true, group: 'rifle' },
  { file: 'rifle_jump.glb', name: 'RifleJump', loop: false, group: 'rifle' },
  { file: 'Rifle Prone To Kneel.glb', name: 'ProneToKneel', loop: false, group: 'stance' },
  { file: 'Rifle Kneel To Stand.glb', name: 'KneelToStand', loop: false, group: 'stance' },

  { file: 'Firing Rifle.glb', name: 'FireRifle', loop: false, group: 'combat' },
  { file: 'Gunplay.glb', name: 'Gunplay', loop: false, group: 'combat' },
  { file: 'Reloading.glb', name: 'Reload', loop: false, group: 'combat' },
  { file: 'Grab Rifle From Behind Shoulder.glb', name: 'DrawRifle', loop: false, group: 'combat' },
  { file: 'Grab And Put Back Rifle (1).glb', name: 'SheatheRifle', loop: false, group: 'combat' },
  { file: 'Combo Punch.glb', name: 'ComboPunch', loop: false, group: 'combat' },

  { file: 'Dying.glb', name: 'Dying', loop: false, group: 'hit' },
  { file: 'Turn To Knocked Unconscious.glb', name: 'KnockedOut', loop: false, group: 'hit' },
];
