# Live-Stream Media Relay v2

Secure FFmpeg relay for the Live-Stream platform.

## API

All protected endpoints require:

`x-media-relay-key: <MEDIA_RELAY_KEY>`

### Public

- `GET /health` — health/status check.
- `GET /` — API discovery.

### v2 session API

- `POST /probe` — probe an input URL with ffprobe.
- `GET /sessions` — list sessions.
- `POST /sessions` — create a session. Body: `{ inputUrl, destinations, autoStart? }`.
- `GET /sessions/:id` — session status.
- `POST /sessions/:id/start` — start all attached destinations.
- `POST /sessions/:id/stop` — stop the session.
- `POST /sessions/:id/join` — attach a destination while a session is running.
- `POST /sessions/:id/destinations` — alias for `/join`.
- `POST /sessions/:id/leave` — remove a destination by `destinationId` or `id`.
- `DELETE /sessions/:id/destinations/:destinationId` — remove a destination.

### Backward-compatible v1 API

- `GET /api/relay`
- `GET /api/relay/:id`
- `POST /api/relay/start`
- `POST /api/relay/:id/stop`

## Dynamic destinations

Version 2 runs one FFmpeg output process per destination. This deliberately replaces the old single `tee` process because a tee muxer cannot reliably add/remove an output while it is already running.

This allows a live session to add or remove RTMP/RTMPS destinations without restarting the other destinations.

The tradeoff is CPU usage: each destination has its own encoding process. Tune `VIDEO_PRESET`, `VIDEO_BITRATE`, `VIDEO_MAXRATE`, `VIDEO_BUFSIZE`, `VIDEO_FPS`, and `VIDEO_GOP` for your Railway plan.

## Environment variables

- `PORT` — supplied by Railway.
- `MEDIA_RELAY_KEY` — required authentication secret.
- `MAX_RELAY_JOBS` — maximum simultaneous sessions, default `4`.
- `MAX_DESTINATIONS` — maximum destinations per session, default `6`.
- `JOB_IDLE_TIMEOUT_MS` — optional automatic stop timeout; `0` disables it.
- `VIDEO_PRESET` — default `veryfast`.
- `VIDEO_BITRATE` — default `4500k`.
- `VIDEO_MAXRATE` — default `5000k`.
- `VIDEO_BUFSIZE` — default `10000k`.
- `VIDEO_FPS` — default `30`.
- `VIDEO_GOP` — default `60`.
- `AUDIO_BITRATE` — default `128k`.
