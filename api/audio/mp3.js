import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// Node runtime (no edge)
export const config = { runtime: "nodejs" };

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

function readRequestBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeFilename(name) {
  const base = String(name || "grabacion.mp3").trim();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.toLowerCase().endsWith(".mp3") ? cleaned : cleaned + ".mp3";
}

async function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error("FFmpeg no disponible en el entorno (ffmpeg-static).");

  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err || `FFmpeg falló (código ${code}).`));
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  try {
    const contentType = String(req.headers["content-type"] || "audio/webm");
    const filename = safeFilename(req.headers["x-filename"] || "grabacion_clinote.mp3");

    const inputBuf = await readRequestBuffer(req);
    if (!inputBuf || inputBuf.length < 10) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Audio vacío o inválido.");
      return;
    }

    const tmp = os.tmpdir();
    const id = crypto.randomBytes(8).toString("hex");

    // extensión solo para ayudar a FFmpeg a inferir, no es la salida final
    const ext = contentType.includes("ogg") ? "ogg" : contentType.includes("wav") ? "wav" : "webm";
    const inPath = path.join(tmp, `clinote_${id}.${ext}`);
    const outPath = path.join(tmp, `clinote_${id}.mp3`);

    await fs.writeFile(inPath, inputBuf);

    // Convertir a mp3 128k
    await runFfmpeg([
      "-y",
      "-i",
      inPath,
      "-vn",
      "-acodec",
      "libmp3lame",
      "-b:a",
      "128k",
      "-f",
      "mp3",
      outPath,
    ]);

    const mp3Buf = await fs.readFile(outPath);

    try { await fs.unlink(inPath); } catch {}
    try { await fs.unlink(outPath); } catch {}

    res.statusCode = 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.end(mp3Buf);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(e?.message ? String(e.message) : "Error al convertir audio a MP3.");
  }
}
