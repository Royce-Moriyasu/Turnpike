import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The repo's virtual environment if there is one (it has the bake's packages), else PATH's python.
const venvPython = path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const PYTHON = existsSync(venvPython) ? venvPython : "python";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The clip folder named by ?clip= (see tools/clip.py). Only existing clips/<name>/ folders are allowed. */
function clipDir(url: string | undefined): { name: string; dir: string } {
  const name = new URL(url ?? "/", "http://dev").searchParams.get("clip") ?? "sr70";
  const dir = path.join(repoRoot, "clips", name);
  if (!/^[a-z0-9_-]+$/i.test(name) || !existsSync(path.join(dir, "clip.json"))) {
    throw new HttpError(400, `unknown clip '${name}'`);
  }
  return { name, dir };
}

/** Dev-only endpoints for the labeling tool and CV review page, per clip (?clip=<name>). */
function labelingApi(): Plugin {
  return {
    name: "labeling-api",
    apply: "serve",
    configureServer(server) {
      const handle = (fn: (req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
        async (req: IncomingMessage, res: ServerResponse) => {
          try {
            await fn(req, res);
          } catch (e) {
            res.statusCode = e instanceof HttpError ? e.status : 500;
            res.end(e instanceof Error ? e.message : String(e));
          }
        };

      // Hand-traced lanes: clips/<clip>/labels.json (the labeling tool reads and autosaves it).
      server.middlewares.use(
        "/__labels",
        handle(async (req, res) => {
          const file = path.join(clipDir(req.url).dir, "labels.json");
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(existsSync(file) ? await readFile(file, "utf-8") : "{}");
          } else if (req.method === "PUT") {
            let body = "";
            for await (const chunk of req) body += chunk;
            JSON.parse(body); // never write malformed JSON over the labels
            await writeFile(file, body);
            res.end("ok");
          } else {
            throw new HttpError(405, "GET or PUT");
          }
        }),
      );

      // Read-only: detected lane lines for the CV review page (#cv). ?source=yolop for the
      // YOLOPv2-based lines (vision/yolop_lanes.py), otherwise the OpenCV output.
      server.middlewares.use(
        "/__detected",
        handle(async (req, res) => {
          const { name, dir } = clipDir(req.url);
          const yolop = new URL(req.url ?? "/", "http://dev").searchParams.get("source") === "yolop";
          const file = path.join(dir, yolop ? "yolop_lanes.json" : "detected_lanes.json");
          if (!existsSync(file)) {
            throw new HttpError(
              404,
              yolop
                ? `clips/${name}/yolop_lanes.json not found: run tools/build_clip.py ${name}`
                : `clips/${name}/detected_lanes.json not found: run tools/build_clip.py ${name} --opencv`,
            );
          }
          res.setHeader("Content-Type", "application/json");
          res.end(await readFile(file, "utf-8"));
        }),
      );

      // Read-only: YOLOPv2 masks, e.g. /__yolop/<clip>/band/lane/<frame id>.png
      server.middlewares.use(
        "/__yolop",
        handle(async (req, res) => {
          const m = /^\/([a-z0-9_-]+)\/(band|full|road)\/(lane|drivable)\/(\d+)\.png$/i.exec(req.url ?? "");
          if (!m) throw new HttpError(400, "expected /__yolop/<clip>/<view>/<lane|drivable>/<id>.png");
          const { dir } = clipDir(`/?clip=${m[1]}`);
          const file = path.join(dir, "_build", "yolop", m[2], m[3], `${m[4]}.png`);
          if (!existsSync(file)) throw new HttpError(404, "no mask");
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "no-cache");
          res.end(req.method === "HEAD" ? undefined : await readFile(file));
        }),
      );

      // Re-bake one clip (the labeling tool's "Re-bake demo" button).
      server.middlewares.use(
        "/__bake",
        handle(async (req, res) => {
          if (req.method !== "POST") throw new HttpError(405, "POST");
          const { name } = clipDir(req.url);
          await new Promise<void>((resolve) =>
            execFile(PYTHON, ["bake/bake_route.py", "--clip", name], { cwd: repoRoot }, (err, stdout, stderr) => {
              res.statusCode = err ? 500 : 200;
              res.end(err ? stderr || String(err) : stdout);
              resolve();
            }),
          );
        }),
      );
    },
  };
}

export default defineConfig({
  // Read .env from the repo root, the same file the bake uses (bake_route.py load_dotenv). Only
  // VITE_* variables reach the browser, so MAPBOX_TOKEN (used by the bake) stays out of the bundle.
  envDir: repoRoot,
  plugins: [react(), tailwindcss(), labelingApi()],
});
