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
      // Read-only: the OpenCV output, for the CV review page (#cv).
      server.middlewares.use("/__detected", async (_req, res) => {
        try {
          res.setHeader("Content-Type", "application/json");
          res.end(await readFile(DETECTED, "utf-8"));
        } catch {
          res.statusCode = 404;
          res.end("data/detected_lanes.json not found: run python vision/detect_lanes.py");
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
