import { defineConfig, type Plugin } from "vite"
import { resolve } from "path"

const here = import.meta.dirname

/** Built from this repo and importing the scene pipeline out of reze-design's
 *  `lib/`. Scene assets stream from assets.reze.one exactly as they do for the
 *  web app, so there is no asset directory to mirror. Nothing here writes into
 *  the Next build — the web app neither knows nor cares this exists. */
function besideLog(): Plugin {
  return {
    name: "beside-log",
    configureServer(server) {
      server.middlewares.use("/_besidelog", (req, res) => {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          console.log("[beside]", body)
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}

export default defineConfig({
  root: resolve(here),
  /** `@` is reze-design, checked out beside this repo.
   *
   *  The scene pipeline — parseSceneDoc, loadSceneInto, the effect and graph
   *  registries — lives there and is shared rather than copied: two hosts, one
   *  implementation, so a new field in the scene document cannot reach one and
   *  miss the other. A path dependency is the interim; the end state is that
   *  pipeline published as its own package the way reze-engine is, at which
   *  point this alias goes away and nothing else here changes. */
  resolve: { alias: { "@": resolve(here, "../reze-design") } },
  /** `lib/` is shared with the Next app, which supplies `process.env`. Vite does
   *  not, and a bare `process` reference is a hard error at module scope — the
   *  scene document never got as far as being read. Replacing the whole object
   *  rather than one key keeps every other read defined-but-undefined, which is
   *  exactly what Next gives an unset variable. */
  define: {
    "process.env": JSON.stringify({
      NODE_ENV: process.env.NODE_ENV ?? "development",
      NEXT_PUBLIC_USE_DEFAULT_SCENE: "true",
    }),
  },
  build: { outDir: resolve(here, "dist"), emptyOutDir: true },
  /** A console for the shell.
   *
   *  Tauri does not forward webview console output to the terminal on macOS,
   *  and a borderless window reports no title, so the two obvious channels for
   *  finding out what the page thinks are both shut. This one is open: the page
   *  posts here and the dev server prints it where `tauri dev` is running. */
  plugins: [besideLog()],

  /** Scene assets live on assets.reze.one, whose bucket CORS names the origins
   *  that may read it — reze.one and the Next dev server, not this one. In dev
   *  (and in `tauri dev`, which loads this very server) the fetch rewrite in
   *  main.ts sends them here instead, same-origin, and this hands them on. A
   *  packaged build has no proxy and needs the Tauri origins allowlisted on the
   *  bucket itself. */
  server: {
    port: 5199,
    proxy: {
      "/_r2": {
        target: "https://assets.reze.one",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/_r2/, ""),
      },
    },
  },
})
