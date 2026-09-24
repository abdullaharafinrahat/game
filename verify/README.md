# Verification harnesses

These drive the real game in headless Chromium with a software GL renderer and assert on
*measured* values from inside the running scene — bone quaternions, world matrices, frame
luminance, capsule rest heights — rather than on screenshots or on the constants the game
believes it is using.

## Setup

They are not wired into `package.json`, because they need a browser download:

```bash
npm install --no-save playwright
npx playwright install --with-deps chromium
```

## Running

Start the game first (`npm run dev`, or `npm run build && npm run preview`), then either run a
harness from this directory or copy them next to their own `node_modules`.

```bash
node regression.mjs                       # the three reported bugs, re-measured
GAME_URL=http://localhost:4173 node regression.mjs   # same checks against a production build
node functional.mjs                       # 14 gameplay behaviours
node side-effects.mjs                     # Babylon side-effect imports at every quality tier
node shadow-check.mjs                     # shadows measurably darken the frame
node measure.mjs                          # capsule, map scale, weapon geometry
```

| Harness | What it proves |
| --- | --- |
| `regression.mjs` | Movement travels along the view axis, the model faces where it walks, look controls are not inverted, the rifle points along the character's forward and stays level, the skeleton is animating, and exactly one locomotion clip carries weight. |
| `functional.mjs` | Fire, decals, reload, crouch, ADS, barrels, death, respawn, falls, quality switching, pause, and that all 27 clips bind with 0 unmatched bones. |
| `side-effects.mjs` | No missing `_WarnImport` components at low/medium/high, in dev and production. |
| `shadow-check.mjs` | Frame luminance drops with the shadow generator on, and the casters list includes the character. |
| `shadow-experiment.mjs` | Sweeps shadow filter configurations to find ones that are actually visible. |
| `measure.mjs`, `barrel.mjs`, `geom.mjs`, `weapon-states.mjs` | Asset and rig measurements that produced the constants in `src/config.ts`. |
| `diagnose.mjs` | Renders the character from both ends of its local Z to establish which way it visually faces. |
| `check.mjs`, `visual.mjs`, `shots.mjs`, `boot-debug.mjs` | Boot smoke tests and screenshots. |

Exit code 0 means every check passed.
