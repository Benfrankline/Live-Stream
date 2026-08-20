# Live-Stream Media Relay

A Railway-ready Node.js + FFmpeg service for pulling a live media source and forwarding it to multiple RTMP/RTMPS destinations.

## Important architecture note

This first version is **pull-based**:

1. The relay receives an `inputUrl`.
2. FFmpeg pulls the live source from that URL.
3. FFmpeg encodes the stream once.
4. The FFmpeg `tee` muxer sends the encoded stream to multiple RTMP/RTMPS destinations.

This means the source must be reachable by the Railway service. This service does **not** open an inbound RTMP publishing port.

## Files

- `server.js` - HTTP API and FFmpeg process manager
- `Dockerfile` - installs Node.js and FFmpeg
- `.env.example` - example configuration

## Required Railway variable

Set:

`MEDIA_RELAY_KEY=<long-random-secret>`

Do not commit the real key to GitHub.

Railway automatically supplies `PORT`; the application listens on `0.0.0.0:$PORT`.

## API

### Health

`GET /health`

No authentication is required.

### Start relay

`POST /api/relay/start`

Header:

`x-media-relay-key: YOUR_SECRET`

Body:

```json
{
  "inputUrl": "rtmps://example-source/live/STREAM_KEY",
  "destinations": [
    {
      "name": "youtube",
      "url": "rtmps://example-youtube-endpoint/app/STREAM_KEY"
    },
    {
      "name": "facebook",
      "url": "rtmps://example-facebook-endpoint/rtmp/STREAM_KEY"
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "message": "Relay job started.",
  "job": {
    "id": "uuid",
    "status": "starting"
  }
}
```

### List relay jobs

`GET /api/relay`

Header:

`x-media-relay-key: YOUR_SECRET`

### Get one job

`GET /api/relay/:id`

Header:

`x-media-relay-key: YOUR_SECRET`

### Stop one job

`POST /api/relay/:id/stop`

Header:

`x-media-relay-key: YOUR_SECRET`

## Test with curl

Health:

```bash
curl https://YOUR-RAILWAY-DOMAIN/health
```

Start a relay:

```bash
curl -X POST "https://YOUR-RAILWAY-DOMAIN/api/relay/start" \
  -H "Content-Type: application/json" \
  -H "x-media-relay-key: YOUR_SECRET" \
  -d '{
    "inputUrl": "rtmps://source.example/live/source-key",
    "destinations": [
      {
        "name": "youtube",
        "url": "rtmps://destination.example/live/destination-key"
      }
    ]
  }'
```

## Security

- API endpoints require `MEDIA_RELAY_KEY`.
- Secrets are not stored in the repository.
- FFmpeg is started with an argument array rather than a shell command.
- Only `rtmp://` and `rtmps://` are accepted as destinations.
- Limit active jobs and destinations with environment variables.

## Production considerations

This is a relay worker, not a complete social-platform integration layer. Your main platform should keep platform credentials/stream keys securely and call this service with the required source and destination URLs.

For a production multi-tenant platform, add a database-backed job registry, per-tenant authorization, audit logging, rate limiting, encrypted destination credentials, and persistent monitoring.

Railway service restarts terminate active FFmpeg processes because the job registry is intentionally in-memory in this first version.
