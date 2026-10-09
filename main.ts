/**
 * One character, no chrome, on a transparent canvas.
 *
 * This is the second host for the scene pipeline. It shares `lib/scene-host.ts`
 * with the editor, so a scene opens here by exactly the path it opens there —
 * the two cannot drift, because there is only one of them.
 *
 * What is different is everything around it. No React, no router, no dock: a
 * canvas, a scene, and a window the operating system has been asked to leave
 * unpainted. The transparency is not a filter over a background — there is no
 * background. `setBackgroundColor(null)` leaves the canvas cleared to zero
 * alpha, the page under it is transparent, and the shell's window is
 * `transparent: true`, so what shows through the character is the desktop.
 */

import { Engine, Vec3 } from "reze-engine"
import { DEMO_SCENE } from "@/lib/default-scene"
import { loadSceneInto } from "@/lib/scene-host"
import { effectParams } from "@/lib/effects"
import { windowToEngine } from "@/lib/effect-schedule"
import { azElToDirection, hexToLinearVec3 } from "@/lib/scene-settings"
import type { Window } from "@tauri-apps/api/window"
import { isTauri } from "@tauri-apps/api/core"

const ASSET_ORIGIN = "https://assets.reze.one/"

/**
 * Send asset reads through the dev proxy.
 *
 * The bucket's CORS names the origins allowed to read it, and this one is not
 * among them — nor is the packaged shell's. Rewriting at `fetch` rather than in
 * the scene document catches every read wherever the URL came from, including
 * the ones the engine builds itself out of a .pmx's own texture paths.
 *
 * Dev only. A packaged build has no proxy behind it and wants the shell's
 * origin on the bucket instead.
 */
if (import.meta.env.DEV) {
  const real = window.fetch
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(ASSET_ORIGIN)) return real("/_r2/" + url.slice(ASSET_ORIGIN.length), init)
    return real(input, init)
  }
}

/** Say something where it can be read — see the beside-log plugin. Dev only, and
 *  deliberately fire-and-forget: diagnostics must never be able to fail a boot. */
function besideLog(...parts: unknown[]) {
  if (!import.meta.env.DEV) return
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")
  void fetch("/_besidelog", { method: "POST", body: line }).catch(() => {})
}

const canvas = document.getElementById("scene") as HTMLCanvasElement

/** How the page knows it is running in the shell, without being told in a URL.
 *
 *  `isTauri()`, NOT `"__TAURI__" in window`: in Tauri v2 that global only
 *  exists when `withGlobalTauri` is set, which it is not — the npm package is
 *  the supported path. Testing for it silently reported "browser tab" inside
 *  the shell, so the window never parked and never even showed itself. */
const inShell = isTauri()

async function boot() {
  const scene = DEMO_SCENE
  const s = scene.state.settings
  const c = scene.state.camera

  const engine = new Engine(canvas, {
    camera: { distance: c.distance, target: new Vec3(...c.target) },
    // No `background` key at all — the scene's colour would paint an opaque
    // rectangle where the desktop is supposed to be.
    world: { color: hexToLinearVec3(s.world.color), strength: s.world.strength },
    sun: {
      color: hexToLinearVec3(s.sun.color),
      strength: s.sun.strength,
      direction: azElToDirection(s.sun.azimuth, s.sun.elevation),
    },
    bloom: { ...s.bloom, color: hexToLinearVec3(s.bloom.color) },
  })

  await engine.init()
  // Said again after init, because the constructor's default is a colour.
  engine.setBackgroundColor(null)

  await loadSceneInto(engine, scene, () => false, {
    // Before a single model byte arrives, so the ground and framing are live
    // while the cast streams in.
    onStage: () => engine.runRenderLoop(),
  })

  applyGround(engine, scene)

  // The cast's outlines. `loadSceneInto` builds the look — materials, graphs,
  // ground — but the post settings live in the editor's sync layer, so a host
  // that only calls the loader renders an unlined figure. This is the first of
  // those settings to come across; the rest still have to.
  engine.setOutlineEnabled(s.outline.enabled)

  // Left is the window's, so the camera gives it up: middle orbits, right pans.
  // A frameless window has nothing else to grab, and dragging the character is
  // the gesture everyone tries first.
  engine.setCameraOrbitButton("middle")

  await applyEffects(engine, scene)

  await startMotions(engine, scene)


  wirePlayback(engine, scene)
  if (inShell) void wireShell()
}

/**
 * The floor to keep: the shadow, not the set.
 *
 * A ground at zero opacity still catches — it is exactly what alpha export
 * renders through — so the plane and its grid disappear while what falls on
 * them does not. That matters more on a desktop than in a scene: a figure with
 * no contact shadow reads as pasted over your windows rather than standing on
 * them.
 *
 * An override, and marked as one. The rule everywhere else here is that the
 * document decides and this renders it; ground opacity and the grid toggle
 * are both already dials in the design page, so this should end up being said
 * there instead of here.
 */
function applyGround(engine: Engine, scene: typeof DEMO_SCENE) {
  const s = scene.state.settings
  engine.setGroundVisible(true)
  engine.addGround({
    diffuseColor: hexToLinearVec3(s.ground.color),
    gridLineColor: hexToLinearVec3(s.ground.grid),
    // The two that turn a floor into a catcher.
    opacity: 0,
    gridLineOpacity: 0,
    shadowStrength: s.ground.shadow ? 1 : 0,
    shadowSoftness: s.sun.softness ?? 0,
    width: s.ground.size,
    height: s.ground.size,
    fadeStart: s.ground.size * (10 / 160),
    fadeEnd: s.ground.size * (80 / 160),
  })
}

/**
 * The scene's effects, installed the way the editor installs them.
 *
 * These are the other half of a scene's look and they do NOT come from the
 * loader — the editor drives them from its sync layer, so a host that only
 * calls `loadSceneInto` shows the cast and the ground and none of the field.
 *
 * Params ride the install rather than being seeded after it: an effect whose
 * first frame runs at the author's default and corrects on the second reads as
 * a flash, which on a colour is exactly what you notice. Influence and schedule
 * go on BY INDEX, because `setEffects` installs the list in order — so instance
 * i is entry i, and the same effect applied twice gets two schedules rather
 * than one shared between them.
 */
async function applyEffects(engine: Engine, scene: typeof DEMO_SCENE) {
  const applied = scene.state.backgroundEffects
  if (!applied?.length) return
  await engine.setEffects(applied.map((e) => ({ wgsl: e.wgsl, params: effectParams(e.wgsl, e.params) })))
  applied.forEach((e, i) => {
    engine.setEffectInfluence(i, e.influence ?? 1)
    engine.setEffectSchedule(i, windowToEngine(e.window))
  })
}

/**
 * Start the cast dancing, and only then let it be seen.
 *
 * `loadSceneInto` leaves an ANIMATED model hidden on purpose — revealing it at
 * load would show a frame of bind pose before the motion's first frame lands,
 * which reads as a glitch. Showing it is therefore the host's job, and a host
 * that does not know this renders a scene with nothing in it: the model is
 * loaded, the loop is running at sixty frames a second, and every one of them
 * is empty.
 *
 * Morphs come after every motion, never interleaved: a morph VMD merges INTO
 * the playing clip, and loading a motion afterwards rebuilds that clip and drops
 * the merge. And the clip is named by ASKING the model what is playing rather
 * than by reading the document — a bundled clip keeps its bundle path as its
 * engine key, so the document's display name is not the key, and merging under
 * that name is indistinguishable from a file with no morphs in it.
 */
async function startMotions(engine: Engine, scene: typeof DEMO_SCENE) {
  for (const entry of scene.assets.models) {
    const clip = entry.animation
    const model = engine.getModel(entry.model.id)
    if (!clip || !model) continue
    try {
      await model.loadVmd(clip.name, clip.url)
      // Looping: a figure that plays its take once and then stands still for
      // the rest of the afternoon is a screenshot with extra steps.
      model.play(clip.name, { loop: true })
    } finally {
      // Reveal on the clip's first pose — or anyway, if the clip failed, since
      // a character who never appears is worse than one standing still.
      engine.setModelTransform(entry.model.id, { visible: true })
    }
  }

  for (const entry of scene.assets.models) {
    const expr = entry.morph
    const model = engine.getModel(entry.model.id)
    if (!expr || !model || entry.stage) continue
    const playing = model.getAnimationProgress().animationName
    try {
      await model.loadVmd(playing ?? expr.name, expr.url, { tracks: "morphs" })
    } catch (e) {
      console.warn("[beside] morph failed:", expr.name, e)
    } finally {
      engine.setModelTransform(entry.model.id, { visible: true })
    }
  }

  engine.resetPhysics()
}

/** Which of the row this window is, stated by the shell that built it. */
function slot(): { i: number; n: number } {
  const s = (window as unknown as { __BESIDE__?: { i: number; n: number } }).__BESIDE__
  return s && Number.isFinite(s.i) && s.n > 0 ? s : { i: 0, n: 1 }
}

/**
 * Stand them in a line along the bottom of the screen.
 *
 * Spacing is by CENTRES rather than by gaps: an even gap between edges leaves
 * the row lopsided the moment a window is a different width, and these are
 * meant to be resizable.
 *
 * `workArea` rather than the monitor's full size, so they sit above the Dock and
 * clear of the menu bar instead of half under them — the two rectangles differ
 * by exactly the furniture you must not cover. Physical pixels throughout: work
 * area and window size are both reported that way, and mixing in logical ones
 * puts the row a Retina factor off the edge.
 */
async function parkInRow(win: Window) {
  const { currentMonitor } = await import("@tauri-apps/api/window")
  const { PhysicalPosition } = await import("@tauri-apps/api/dpi")
  const mon = await currentMonitor()
  if (!mon) return
  const size = await win.outerSize()
  const area = mon.workArea
  const margin = Math.round(24 * mon.scaleFactor)

  const { i, n } = slot()

  // Centres spread evenly across the usable width, then each window hung from
  // its own centre — so a row of unequal windows still reads as a row.
  const usable = area.size.width - 2 * margin
  const step = n > 1 ? usable / n : 0
  const centre = area.position.x + margin + (n > 1 ? step * (i + 0.5) : usable / 2)

  besideLog("park", { label: win.label, i, n, centre: Math.round(centre) })

  await win.setPosition(
    new PhysicalPosition(
      Math.round(centre - size.width / 2),
      area.position.y + area.size.height - size.height - margin,
    ),
  )
}

/**
 * Space holds her still.
 *
 * The motion loops on its own — that is the whole point — so the key
 * is spent on the one thing looping takes away, which is stopping. Every model
 * at once, because they are dancing to one track and pausing half a cast is
 * never what anyone meant.
 */
function wirePlayback(engine: Engine, scene: typeof DEMO_SCENE) {
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return
    e.preventDefault()
    for (const entry of scene.assets.models) {
      const model = engine.getModel(entry.model.id)
      if (!model) continue
      if (model.getAnimationProgress().paused) model.play()
      else model.pause()
    }
  })
}

/**
 * Moving a window that has nothing to grab.
 *
 * There is no title bar, so the character is the handle: left-drag moves the
 * window. The camera gives that button up (setCameraOrbitButton) and keeps the
 * other two — middle orbits, right pans, the wheel zooms.
 */
async function wireShell() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  const win = getCurrentWindow()

  // Hidden until it is where it belongs (see tauri.conf.json), so it never
  // appears centred and then jumps. `finally`, because a window that stayed
  // invisible because the monitor query failed is the worst of both.
  try {
    await parkInRow(win)
  } catch (e) {
    besideLog("park FAILED:", String(e))
  }
  // Unconditionally, and after: the window starts hidden so it never appears
  // centred and then jumps, which makes showing it the one step that must
  // happen whatever else did not.
  await win.show()

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    // `startDragging` hands the gesture to the window manager, so the window
    // snaps and settles like any other. Tracking the cursor in JS and calling
    // setPosition per frame puts it a frame behind the pointer, which is the
    // difference between dragging a window and dragging a kite.
    void win.startDragging()
  })
}

void boot()
