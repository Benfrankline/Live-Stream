const express = require("express");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "512kb" }));

const PORT = Number(process.env.PORT || 3000);
const MEDIA_RELAY_KEY = process.env.MEDIA_RELAY_KEY || "";
const MAX_SESSIONS = Number(process.env.MAX_RELAY_JOBS || 4);
const MAX_DESTINATIONS = Number(process.env.MAX_DESTINATIONS || 6);
const JOB_IDLE_TIMEOUT_MS = Number(process.env.JOB_IDLE_TIMEOUT_MS || 0);
const APP_VERSION = process.env.APP_VERSION || "2.0.0";

const sessions = new Map();

function jsonError(res, status, message, details) {
  return res.status(status).json({ ok: false, error: message, ...(details ? { details } : {}) });
}

function requireKey(req, res, next) {
  if (!MEDIA_RELAY_KEY) return jsonError(res, 503, "Relay authentication is not configured.");
  const supplied = req.get("x-media-relay-key") || "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(MEDIA_RELAY_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return jsonError(res, 401, "Invalid relay key.");
  next();
}

function validateUrl(value, field, protocols) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be a valid URL.`); }
  if (!protocols.includes(url.protocol)) throw new Error(`${field} uses an unsupported protocol.`);
  return url.toString();
}

function validateInputUrl(value) {
  return validateUrl(value, "inputUrl", ["rtmp:", "rtmps:", "http:", "https:"]);
}

function validateDestination(value) {
  return validateUrl(value, "destination", ["rtmp:", "rtmps:"]);
}

function normalizeDestinations(destinations) {
  if (!Array.isArray(destinations)) throw new Error("destinations must be an array.");
  if (destinations.length > MAX_DESTINATIONS) throw new Error(`A maximum of ${MAX_DESTINATIONS} destinations is allowed.`);
  return destinations.map((item, index) => normalizeDestination(item, index));
}

function normalizeDestination(item, index = 0) {
  if (typeof item === "string") item = { url: item };
  if (!item || typeof item !== "object" || typeof item.url !== "string" || !item.url.trim()) {
    throw new Error(`Destination ${index + 1} must contain a url.`);
  }
  return {
    id: String(item.id || crypto.randomUUID()),
    name: String(item.name || `destination-${index + 1}`).slice(0, 80),
    url: validateDestination(item.url.trim()),
    status: "pending",
    startedAt: null,
    stoppedAt: null,
    exitCode: null,
    signal: null,
    lastLog: null,
    process: null
  };
}

function destinationPublic(d) {
  let host = "unknown";
  try { host = new URL(d.url).host; } catch {}
  return {
    id: d.id,
    name: d.name,
    urlHost: host,
    status: d.status,
    startedAt: d.startedAt,
    stoppedAt: d.stoppedAt,
    exitCode: d.exitCode,
    signal: d.signal,
    lastLog: d.lastLog
  };
}

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    inputUrl: session.inputUrl,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    lastLog: session.lastLog,
    destinations: session.destinations.map(destinationPublic)
  };
}

function ffmpegArgs(inputUrl, destination) {
  return [
    "-hide_banner", "-nostdin", "-loglevel", "warning",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-i", inputUrl,
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "libx264", "-preset", process.env.VIDEO_PRESET || "veryfast",
    "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-r", String(process.env.VIDEO_FPS || 30),
    "-g", String(process.env.VIDEO_GOP || 60),
    "-keyint_min", String(process.env.VIDEO_GOP || 60),
    "-sc_threshold", "0",
    "-b:v", process.env.VIDEO_BITRATE || "4500k",
    "-maxrate", process.env.VIDEO_MAXRATE || "5000k",
    "-bufsize", process.env.VIDEO_BUFSIZE || "10000k",
    "-c:a", "aac", "-b:a", process.env.AUDIO_BITRATE || "128k", "-ar", "44100",
    "-f", "flv", destination
  ];
}

function attachLogs(session, destination, stream) {
  let buffer = "";
  stream.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const clean = line.trim();
      if (clean) {
        destination.lastLog = clean.slice(-1000);
        session.lastLog = destination.lastLog;
        console.log(`[relay:${session.id}:${destination.id}] ${clean}`);
      }
    }
  });
}

function startDestination(session, destination) {
  if (!["pending", "stopped", "failed"].includes(destination.status)) return false;

  const args = ffmpegArgs(session.inputUrl, destination.url);
  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  destination.process = ffmpeg;
  destination.status = "starting";
  destination.startedAt = new Date().toISOString();
  destination.stoppedAt = null;
  destination.exitCode = null;
  destination.signal = null;

  attachLogs(session, destination, ffmpeg.stderr);
  attachLogs(session, destination, ffmpeg.stdout);

  ffmpeg.on("spawn", () => {
    destination.status = "running";
    refreshSessionStatus(session);
  });

  ffmpeg.on("error", err => {
    destination.status = "failed";
    destination.lastLog = err.message;
    session.lastLog = err.message;
    refreshSessionStatus(session);
  });

  ffmpeg.on("close", (code, signal) => {
    if (destination.status !== "stopping") destination.status = code === 0 ? "stopped" : "failed";
    else destination.status = "stopped";
    destination.exitCode = code;
    destination.signal = signal;
    destination.stoppedAt = new Date().toISOString();
    destination.process = null;
    refreshSessionStatus(session);
  });

  return true;
}

function refreshSessionStatus(session) {
  const active = session.destinations.some(d => ["starting", "running", "stopping"].includes(d.status));
  const running = session.destinations.some(d => d.status === "running");
  const pending = session.destinations.some(d => d.status === "pending");

  if (session.status === "stopping") {
    if (!active) session.status = "stopped";
  } else if (running) {
    session.status = "running";
  } else if (active) {
    session.status = "starting";
  } else if (pending) {
    session.status = "created";
  } else if (session.startedAt) {
    session.status = "stopped";
  }

  if (session.status === "stopped" && !session.stoppedAt) session.stoppedAt = new Date().toISOString();
}

function startSession(session) {
  if (!["created", "stopped"].includes(session.status)) throw new Error(`Session cannot be started from status ${session.status}.`);
  session.status = "starting";
  session.startedAt = session.startedAt || new Date().toISOString();
  session.stoppedAt = null;
  for (const destination of session.destinations) startDestination(session, destination);
  refreshSessionStatus(session);
  return session;
}

function stopDestination(destination) {
  if (!destination.process || !["starting", "running"].includes(destination.status)) return false;
  destination.status = "stopping";
  try { destination.process.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    if (destination.process && destination.status === "stopping") {
      try { destination.process.kill("SIGKILL"); } catch {}
    }
  }, 10000).unref();
  return true;
}

function stopSession(session) {
  const active = session.destinations.filter(d => ["starting", "running"].includes(d.status));
  if (!active.length) return false;
  session.status = "stopping";
  active.forEach(stopDestination);
  refreshSessionStatus(session);
  return true;
}

function createSession(inputUrl, destinations) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`Maximum active relay sessions (${MAX_SESSIONS}) reached.`);
  const session = {
    id: crypto.randomUUID(),
    status: "created",
    inputUrl,
    destinations,
    createdAt: new Date().toISOString(),
    startedAt: null,
    stoppedAt: null,
    lastLog: null,
    idleTimer: null
  };
  sessions.set(session.id, session);
  if (JOB_IDLE_TIMEOUT_MS > 0) {
    session.idleTimer = setTimeout(() => {
      if (["starting", "running"].includes(session.status)) stopSession(session);
    }, JOB_IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }
  return session;
}

function probeUrl(inputUrl) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-show_entries", "format=format_name,duration:stream=index,codec_type,codec_name,width,height,r_frame_rate", "-of", "json", inputUrl];
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c.toString(); });
    child.stderr.on("data", c => { err += c.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("Probe timed out.")); }, 20000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().slice(-2000) || `ffprobe exited with code ${code}.`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error("ffprobe returned invalid JSON.")); }
    });
  });
}

app.get("/health", (req, res) => res.json({
  ok: true, service: "live-stream-media-relay", version: APP_VERSION,
  ffmpeg: "available-at-runtime", activeSessions: [...sessions.values()].filter(s => ["starting", "running", "stopping"].includes(s.status)).length,
  time: new Date().toISOString()
}));

app.get("/", (req, res) => res.json({
  ok: true, service: "Live-Stream Media Relay", version: APP_VERSION,
  endpoints: { health: "GET /health", probe: "POST /probe", sessions: "GET /sessions", createSession: "POST /sessions", session: "GET /sessions/:id", start: "POST /sessions/:id/start", stop: "POST /sessions/:id/stop", join: "POST /sessions/:id/join", leave: "POST /sessions/:id/leave", legacyStart: "POST /api/relay/start", legacyStop: "POST /api/relay/:id/stop" }
}));

app.use(requireKey);

app.post("/probe", async (req, res) => {
  try {
    const value = req.body?.inputUrl || req.body?.url;
    if (typeof value !== "string" || !value.trim()) return jsonError(res, 400, "inputUrl is required.");
    const inputUrl = validateInputUrl(value.trim());
    const probe = await probeUrl(inputUrl);
    res.json({ ok: true, inputUrl, probe });
  } catch (err) { jsonError(res, 400, err.message || "Unable to probe input."); }
});

app.get("/sessions", (req, res) => res.json({ ok: true, sessions: [...sessions.values()].map(publicSession) }));

app.post("/sessions", (req, res) => {
  try {
    const inputUrl = validateInputUrl(String(req.body?.inputUrl || req.body?.input || "").trim());
    const destinations = normalizeDestinations(req.body?.destinations || []);
    const session = createSession(inputUrl, destinations);
    if (req.body?.autoStart === true || req.body?.start === true) startSession(session);
    res.status(201).json({ ok: true, session: publicSession(session) });
  } catch (err) { jsonError(res, 400, err.message || "Unable to create session."); }
});

app.get("/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Session not found.");
  res.json({ ok: true, session: publicSession(session) });
});

app.post("/sessions/:id/start", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Session not found.");
  try { startSession(session); res.status(202).json({ ok: true, message: "Session started.", session: publicSession(session) }); }
  catch (err) { jsonError(res, 409, err.message); }
});

app.post("/sessions/:id/stop", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Session not found.");
  if (!stopSession(session)) return jsonError(res, 409, `Session cannot be stopped from status ${session.status}.`);
  res.json({ ok: true, message: "Stop signal sent.", session: publicSession(session) });
});

function joinDestination(req, res) {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Session not found.");
  try {
    if (session.destinations.length >= MAX_DESTINATIONS) throw new Error(`A maximum of ${MAX_DESTINATIONS} destinations is allowed.`);
    const destination = normalizeDestination(req.body?.destination || req.body, session.destinations.length);
    if (session.destinations.some(d => d.url === destination.url)) throw new Error("That destination is already attached to the session.");
    session.destinations.push(destination);
    if (["starting", "running"].includes(session.status)) startDestination(session, destination);
    refreshSessionStatus(session);
    return res.status(201).json({ ok: true, message: "Destination joined.", destination: destinationPublic(destination), session: publicSession(session) });
  } catch (err) { return jsonError(res, 400, err.message); }
}

app.post("/sessions/:id/join", joinDestination);
app.post("/sessions/:id/destinations", joinDestination);

app.post("/sessions/:id/leave", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Session not found.");
  const id = req.body?.destinationId || req.body?.id;
  const destination = id ? session.destinations.find(d => d.id === id) : session.destinations.find(d => d.name === req.body?.name);
  if (!destination) return jsonError(res, 404, "Destination not found.");
  stopDestination(destination);
  session.destinations = session.destinations.filter(d => d.id !== destination.id);
  refreshSessionStatus(session);
  res.json({ ok: true, message: "Destination removed.", session: publicSession(session) });
});

app.delete("/sessions/:id/destinations/:destinationId", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Session not found.");
  const destination = session.destinations.find(d => d.id === req.params.destinationId);
  if (!destination) return jsonError(res, 404, "Destination not found.");
  stopDestination(destination);
  session.destinations = session.destinations.filter(d => d.id !== destination.id);
  refreshSessionStatus(session);
  res.json({ ok: true, message: "Destination removed.", session: publicSession(session) });
});

// Backward-compatible API v1.
app.get("/api/relay", (req, res) => res.json({ ok: true, jobs: [...sessions.values()].map(publicSession) }));
app.get("/api/relay/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Relay job not found.");
  res.json({ ok: true, job: publicSession(session) });
});
app.post("/api/relay/start", (req, res) => {
  try {
    const inputUrl = validateInputUrl(String(req.body?.inputUrl || "").trim());
    const destinations = normalizeDestinations(req.body?.destinations || []);
    const session = createSession(inputUrl, destinations);
    startSession(session);
    res.status(202).json({ ok: true, message: "Relay job started.", job: publicSession(session), session: publicSession(session) });
  } catch (err) { jsonError(res, 400, err.message || "Unable to start relay."); }
});
app.post("/api/relay/:id/stop", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return jsonError(res, 404, "Relay job not found.");
  if (!stopSession(session)) return jsonError(res, 409, `Job cannot be stopped because its current status is ${session.status}.`);
  res.json({ ok: true, message: "Stop signal sent.", job: publicSession(session) });
});

app.use((err, req, res, next) => { console.error("Unhandled request error:", err); jsonError(res, 500, "Internal server error."); });

const server = app.listen(PORT, "0.0.0.0", () => console.log(`Live-Stream Media Relay v${APP_VERSION} listening on 0.0.0.0:${PORT}`));

function shutdown(signal) {
  console.log(`Received ${signal}; stopping active relay sessions...`);
  for (const session of sessions.values()) stopSession(session);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
