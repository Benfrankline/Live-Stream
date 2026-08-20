FROM node:22-bookworm-slim

ENV NODE_ENV=production

# FFmpeg is required by the relay worker.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY relay/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY relay/server.js ./

# Railway supplies PORT at runtime. The application listens on it.
EXPOSE 3000

CMD ["node", "server.js"]
