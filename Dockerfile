FROM node:22-bookworm-slim

# Virtual display, software OpenGL (Mesa), video encoder and audio server
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth x11-xkb-utils xkb-data libgl1 libgl1-mesa-dri libglx-mesa0 libegl1 \
      ffmpeg pulseaudio libpulse0 libopenal1 \
      libxcursor1 libxrandr2 libxxf86vm1 libxi6 libxtst6 libxrender1 libxext6 libasound2 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN useradd -m -u 1001 mc && mkdir -p /data /tmp/mcweb && chown -R mc /data /tmp/mcweb
USER mc
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
