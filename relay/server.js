const express = require("express");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const MEDIA_RELAY_KEY = process.env.MEDIA_RELAY_KEY || "";
const MAX_JOBS = Number(process.env.MAX_RELAY_JOBS || 4);
const MAX_DESTINATIONS = Number(process.env.MAX_DESTINATIONS || 6);
const JOB_IDLE_TIMEOUT_MS = Number(process.env.JOB_IDLE_TIMEOUT_MS || 0);

const jobs = new Map();

function jsonError(res, status, message, details) {
  return res.status(status).json({
    ok: false,
    error: message,
    ...(details ? { details } : {})
  });
}

function requireKey(req, res, next) {
  if (!MEDIA_RELAY_KEY) {
    return jsonError(res, 503, "Relay authentication is not configured.");
  }

  const supplied = req.get("x-media-relay-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(MEDIA_RELAY_KEY);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return jsonError(res, 401, "Invalid relay key.");
  }

  next();
}

function validateHttpUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }

  if (!["rtmp:", "rtmps:", "http:", "https:"].includes(url.protocol)) {
    throw new Error(`${field} uses an unsupported protocol.`);
  }

  // Only RTMP/RTMPS are accepted as output destinations.
  if (field === "destination" && !["rtmp:", "rtmps:"].includes(url.protocol)) {
    throw new Error("Each destination must use rtmp:// or rtmps://.");
  }

  return url.toString();
}

function validateInputUrl(value) {
  const url = validateHttpUrl(value, "inputUrl");

  // The relay is intentionally pull-based. It does not expose an arbitrary
  // RTMP listener port. Your encoder/source must publish somewhere reachable
  // by this service, or the source must otherwise be a supported pull URL.
  return url;
}

function sanitizeDestinations(destinations) {
  if (!Array.isArray(destinations) || destinations.length < 1) {
    throw new Error("destinations must be a non-empty array.");
  }

  if (destinations.length > MAX_DESTINATIONS) {
    throw new Error(`A maximum of ${MAX_DESTINATIONS} destinations is allowed.`);
  }

  return destinations.map((item, index) => {
    if (typeof item === "string") {
      return { name: `destination-${index + 1}`, url: validateHttpUrl(item, "destination") };
    }

    if (!item || typeof item !== "object" || typeof item.url !== "string") {
      throw new Error(`Destination ${index + 1} must contain a url.`);
    }

    return {
      name: String(item.name || `destination-${index + 1}`).slice(0, 80),
      url: validateHttpUrl(item.url, "destination")
    };
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    inputUrl: job.inputUrl,
    destinations: job.destinations.map(d => ({
      name: d.name,
      urlHost: (() => {
        try { return new URL(d.url).host; } catch { return "unknown"; }
      })()
    })),
    startedAt: job.startedAt,
    stoppedAt: job.stoppedAt || null,
    exitCode: job.exitCode ?? null,
    signal: job.signal || null,
    lastLog: job.lastLog || null
  };
}

function buildFfmpegArgs(inputUrl, destinations) {
  const teeTargets = destinations.map((destination) => {
    // FFmpeg tee syntax. URLs are passed as arguments, never through a shell.
    return `[f=flv:onfail=ignore]${destination.url}`;
  }).join("|");

  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "warning",

    // Helpful for network inputs that temporarily disconnect.
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",

    "-i", inputUrl,

    // Video is encoded once and sent to all outputs through the tee muxer.
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", process.env.VIDEO_PRESET || "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-r", String(process.env.VIDEO_FPS || 30),
    "-g", String(process.env.VIDEO_GOP || 60),
    "-keyint_min", String(process.env.VIDEO_GOP || 60),
    "-sc_threshold", "0",
    "-b:v", process.env.VIDEO_BITRATE || "4500k",
    "-maxrate", process.env.VIDEO_MAXRATE || "5000k",
    "-bufsize", process.env.VIDEO_BUFSIZE || "10000k",
    "-c:a", "aac",
    "-b:a", process.env.AUDIO_BITRATE || "128k",
    "-ar", "44100",
    "-f", "tee",
    teeTargets
  ];
}

function startJob({ inputUrl, destinations }) {
  if (jobs.size >= MAX_JOBS) {
    throw new Error(`Maximum active relay jobs (${MAX_JOBS}) reached.`);
  }

  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const args = buildFfmpegArgs(inputUrl, destinations);

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  const job = {
    id,
    status: "starting",
    inputUrl,
    destinations,
    startedAt,
    stoppedAt: null,
    exitCode: null,
    signal: null,
    lastLog: null,
    process: ffmpeg,
    idleTimer: null
  };

  jobs.set(id, job);

  const consumeLogs = (stream) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const clean = line.trim();
        if (clean) {
          job.lastLog = clean.slice(-1000);
          console.log(`[relay:${id}] ${clean}`);
        }
      }
    });
  };

  consumeLogs(ffmpeg.stderr);
  consumeLogs(ffmpeg.stdout);

  ffmpeg.on("spawn", () => {
    job.status = "running";
  });

  ffmpeg.on("error", (err) => {
    job.status = "failed";
    job.lastLog = err.message;
    console.error(`[relay:${id}] process error:`, err);
  });

  ffmpeg.on("close", (code, signal) => {
    if (job.status !== "stopping") {
      job.status = code === 0 ? "stopped" : "failed";
    } else {
      job.status = "stopped";
    }

    job.exitCode = code;
    job.signal = signal;
    job.stoppedAt = new Date().toISOString();

    if (job.idleTimer) clearTimeout(job.idleTimer);

    // Keep completed jobs in memory briefly so their final status can be read.
    setTimeout(() => jobs.delete(id), 15 * 60 * 1000).unref();
  });

  if (JOB_IDLE_TIMEOUT_MS > 0) {
    job.idleTimer = setTimeout(() => {
      if (job.status === "running" || job.status === "starting") {
        stopJob(job);
      }
    }, JOB_IDLE_TIMEOUT_MS);
    job.idleTimer.unref();
  }

  return job;
}

function stopJob(job) {
  if (!job || !job.process) return false;

  if (!["running", "starting"].includes(job.status)) {
    return false;
  }

  job.status = "stopping";

  // SIGTERM allows FFmpeg to close outputs cleanly.
  job.process.kill("SIGTERM");

  // Force termination if it does not exit promptly.
  setTimeout(() => {
    if (!job.process.killed && ["stopping", "running"].includes(job.status)) {
      try { job.process.kill("SIGKILL"); } catch {}
    }
  }, 10000).unref();

  return true;
}

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "live-stream-media-relay",
    version: process.env.APP_VERSION || "1.0.0",
    ffmpeg: "available-at-runtime",
    activeJobs: [...jobs.values()].filter(j => ["starting", "running", "stopping"].includes(j.status)).length,
    time: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Live-Stream Media Relay",
    endpoints: {
      health: "GET /health",
      start: "POST /api/relay/start",
      list: "GET /api/relay",
      status: "GET /api/relay/:id",
      stop: "POST /api/relay/:id/stop"
    }
  });
});

app.use("/api", requireKey);

app.get("/api/relay", (req, res) => {
  res.json({
    ok: true,
    jobs: [...jobs.values()].map(publicJob)
  });
});

app.get("/api/relay/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return jsonError(res, 404, "Relay job not found.");
  res.json({ ok: true, job: publicJob(job) });
});

app.post("/api/relay/start", (req, res) => {
  try {
    const { inputUrl, destinations } = req.body || {};

    if (typeof inputUrl !== "string" || !inputUrl.trim()) {
      return jsonError(res, 400, "inputUrl is required.");
    }

    const normalizedInput = validateInputUrl(inputUrl.trim());
    const normalizedDestinations = sanitizeDestinations(destinations);

    const job = startJob({
      inputUrl: normalizedInput,
      destinations: normalizedDestinations
    });

    return res.status(202).json({
      ok: true,
      message: "Relay job started.",
      job: publicJob(job)
    });
  } catch (err) {
    console.error("Start relay error:", err);
    return jsonError(res, 400, err.message || "Unable to start relay.");
  }
});

app.post("/api/relay/:id/stop", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return jsonError(res, 404, "Relay job not found.");

  if (!stopJob(job)) {
    return jsonError(res, 409, `Job cannot be stopped because its current status is ${job.status}.`);
  }

  res.json({
    ok: true,
    message: "Stop signal sent.",
    job: publicJob(job)
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  return jsonError(res, 500, "Internal server error.");
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Live-Stream Media Relay listening on 0.0.0.0:${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; stopping active relay jobs...`);

  for (const job of jobs.values()) {
    stopJob(job);
  }

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(1), 15000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
