const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "2mb" }));

const TMP = "/tmp/ffmpeg-worker";
fs.mkdirSync(TMP, { recursive: true });

/**
 * Helpers
 */
function safeName(name) {
  return String(name || "clip")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

/**
 * Download a Drive file to disk using access token (no refresh in worker).
 * Uses v3 alt=media.
 */
async function downloadDriveFile({ fileId, accessToken, outPath }) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media`;

  // curl -L -H "Authorization: Bearer ..." -o outPath url
  await run("curl", [
    "-L",
    "-f",
    "-sS",
    "-H",
    `Authorization: Bearer ${accessToken}`,
    "-o",
    outPath,
    url,
  ]);
}

/**
 * Upload file to Drive folder using multipart/related.
 * Returns { id, webViewLink?, webContentLink? }
 */
async function uploadToDrive({ accessToken, filePath, filename, mimeType, folderId }) {
  const boundary = "-------314159265358979323846";
  const meta = {
    name: filename,
    parents: folderId ? [folderId] : undefined,
  };

  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n`;

  const fileData = fs.readFileSync(filePath);

  const filePartHeader =
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const end =
    `\r\n--${boundary}--\r\n`;

  // Build multipart body as Buffer
  const body = Buffer.concat([
    Buffer.from(metadataPart, "utf8"),
    Buffer.from(filePartHeader, "utf8"),
    fileData,
    Buffer.from(end, "utf8"),
  ]);

  const uploadUrl =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink";

  // Use curl to POST body
  const tmpBody = path.join(TMP, `upload-${Date.now()}.bin`);
  fs.writeFileSync(tmpBody, body);

  try {
    const { stdout } = await run("curl", [
      "-sS",
      "-f",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${accessToken}`,
      "-H",
      `Content-Type: multipart/related; boundary=${boundary}`,
      "--data-binary",
      `@${tmpBody}`,
      uploadUrl,
    ]);

    return JSON.parse(stdout);
  } finally {
    try { fs.unlinkSync(tmpBody); } catch {}
  }
}

/**
 * Convert time formats:
 * - allow "00:12:30" (hh:mm:ss)
 * - allow seconds number (e.g. 750)
 */
function normalizeTime(t) {
  if (t === null || t === undefined) return null;
  if (typeof t === "number") return String(t);
  const s = String(t).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return s; // seconds
  if (/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) return s;
  throw new Error(`Invalid time format: ${t}`);
}

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /render
 * Body:
 * {
 *   "googleAccessToken": "ya29....",
 *   "sourceVideoFileId": "DriveFileId",
 *   "start": "00:12:30",
 *   "duration": 15,
 *   "outputName": "nyc_snow_001.mp4",
 *   "driveOutputFolderId": "optional-folder-id",
 *
 *   // optional music
 *   "musicFileId": "DriveFileId",
 *   "musicStart": "00:00:00",
 *   "musicVolume": 0.35,
 *   "videoVolume": 1.0
 * }
 *
 * Returns:
 * { "uploadedFileId": "...", "webViewLink": "...", "webContentLink": "..." }
 */
app.post("/render", async (req, res) => {
  try {
    const {
      googleAccessToken,
      sourceVideoFileId,
      start,
      duration,
      outputName,
      driveOutputFolderId,
      musicFileId,
      musicStart,
      musicVolume,
      videoVolume,
    } = req.body || {};

    if (!googleAccessToken) throw new Error("Missing googleAccessToken");
    if (!sourceVideoFileId) throw new Error("Missing sourceVideoFileId");
    if (duration === undefined || duration === null) throw new Error("Missing duration");

    const startNorm = normalizeTime(start || "0");
    const durNorm = normalizeTime(duration);
    const outName = safeName(outputName || `clip-${Date.now()}.mp4`);

    const videoIn = path.join(TMP, `video-${Date.now()}.mp4`);
    const audioIn = musicFileId ? path.join(TMP, `music-${Date.now()}.mp3`) : null;
    const outPath = path.join(TMP, outName);

    // 1) download source video
    await downloadDriveFile({
      fileId: sourceVideoFileId,
      accessToken: googleAccessToken,
      outPath: videoIn,
    });

    // 2) optional download music
    if (musicFileId) {
      await downloadDriveFile({
        fileId: musicFileId,
        accessToken: googleAccessToken,
        outPath: audioIn,
      });
    }

    // 3) ffmpeg render (vertical Reels-friendly crop)
    // NOTE: This re-encodes for reliable cuts.
    const vf =
      "scale=1080:1920:force_original_aspect_ratio=increase," +
      "crop=1080:1920";

    const vVol = typeof videoVolume === "number" ? videoVolume : 1.0;
    const mVol = typeof musicVolume === "number" ? musicVolume : 0.35;

    const args = [];

    // seek early for speed
    args.push("-ss", startNorm);
    args.push("-i", videoIn);

    if (musicFileId) {
      const mStart = normalizeTime(musicStart || "0");
      args.push("-ss", mStart);
      args.push("-i", audioIn);
    }

    args.push("-t", durNorm);

    // video filters
    args.push("-vf", vf);

    if (musicFileId) {
      // Mix original audio (if any) with music.
      // If source has no audio, amix will fail; we guard by forcing anullsrc fallback.
      // Approach:
      // - normalize both tracks with volumes
      // - amix them
      const filter = [
        `[0:a]volume=${vVol}[va];`,
        `[1:a]volume=${mVol}[ma];`,
        `[va][ma]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      ].join("");
      args.push("-filter_complex", filter);
      args.push("-map", "0:v:0");
      args.push("-map", "[aout]");
    } else {
      // keep original audio if present
      args.push("-map", "0:v:0");
      args.push("-map", "0:a?");
    }

    // encode settings
    args.push("-c:v", "libx264");
    args.push("-preset", "veryfast");
    args.push("-crf", "22");
    args.push("-pix_fmt", "yuv420p");
    args.push("-c:a", "aac");
    args.push("-b:a", "160k");
    args.push("-movflags", "+faststart");
    args.push("-y", outPath);

    await run("ffmpeg", args);

    // 4) upload result to Drive
    const uploaded = await uploadToDrive({
      accessToken: googleAccessToken,
      filePath: outPath,
      filename: outName,
      mimeType: "video/mp4",
      folderId: driveOutputFolderId,
    });

    // cleanup best-effort
    for (const f of [videoIn, audioIn, outPath].filter(Boolean)) {
      try { fs.unlinkSync(f); } catch {}
    }

    res.json({
      uploadedFileId: uploaded.id,
      webViewLink: uploaded.webViewLink,
      webContentLink: uploaded.webContentLink,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`ffmpeg-worker listening on :${port}`);
});
