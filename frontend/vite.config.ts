import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABELS = path.join(repoRoot, "data", "fallback_lanes.json");
const DETECTED = path.join(repoRoot, "data", "detected_lanes.json");
const YOLOP_LANES = path.join(repoRoot, "data", "yolop_lanes.json");

/** Dev-only endpoints for the labeling tool: read/write data/fallback_lanes.json and re-run the bake. */
function labelingApi(): Plugin {
  return {
    name: "labeling-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__labels", async (req, res) => {
        try {
          if (req.method === "GET") {
            res.setHeader("Content-Type", "application/json");
            res.end(await readFile(LABELS, "utf-8"));
          } else if (req.method === "PUT") {
            let body = "";
            for await (const chunk of req) body += chunk;
            JSON.parse(body); // never write malformed JSON over the labels
            await writeFile(LABELS, body);
            res.end("ok");
          } else {
            res.statusCode = 405;
            res.end();
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
      // Read-only: detected lane lines for the CV review page (#cv). ?source=yolop for the
      // YOLOPv2-based lines (vision/yolop_lanes.py), otherwise the OpenCV output.
      server.middlewares.use("/__detected", async (req, res) => {
        const yolop = new URL(req.url ?? "/", "http://dev").searchParams.get("source") === "yolop";
        try {
          res.setHeader("Content-Type", "application/json");
          res.end(await readFile(yolop ? YOLOP_LANES : DETECTED, "utf-8"));
        } catch {
          res.statusCode = 404;
          res.end(yolop
            ? "data/yolop_lanes.json not found: run vision/yolop_masks.py, then vision/yolop_lanes.py"
            : "data/detected_lanes.json not found: run python vision/detect_lanes.py");
        }
      });
      // Read-only: YOLOPv2 masks from vision/yolop_masks.py, e.g. /__yolop/band/lane/<frame id>.png
      server.middlewares.use("/__yolop", async (req, res) => {
        const m = /^\/(band|full|road)\/(lane|drivable)\/(\d+)\.png$/.exec(req.url ?? "");
        if (!m) {
          res.statusCode = 400;
          return res.end();
        }
        try {
          const png = await readFile(path.join(repoRoot, "data", "yolop", m[1], m[2], `${m[3]}.png`));
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Cache-Control", "no-cache");
          res.end(req.method === "HEAD" ? undefined : png);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
      server.middlewares.use("/__bake", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        execFile("python", ["bake/bake_route.py", "--frames"], { cwd: repoRoot }, (err, stdout, stderr) => {
          res.statusCode = err ? 500 : 200;
          res.end(err ? stderr || String(err) : stdout);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), labelingApi()],
});
