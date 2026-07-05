# MadHoney — self-hostable Discord anti-spam bot.
#
# Fonts are bundled in the image (see fonts.js), so NO system font packages are
# needed for banner/captcha rendering. A glibc base (bookworm) is used because
# @napi-rs/canvas ships a prebuilt native binary for it — no compiler, no build
# tools, no cairo/pango system libs required.
FROM node:22-bookworm-slim

# Run as a non-root user.
RUN groupadd -r madhoney && useradd -r -g madhoney -m -d /home/madhoney madhoney

WORKDIR /app

# Install production deps first so this layer caches until deps change.
# @napi-rs/canvas downloads the matching prebuilt binary during install.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source (respects .dockerignore).
COPY . .
RUN chown -R madhoney:madhoney /app

USER madhoney
ENV NODE_ENV=production

# File-store state lives here; mount a volume on it to persist across rebuilds.
ENV MADHONEY_DATA_DIR=/data
VOLUME ["/data"]

# Dashboard port (only matters if you run the dashboard). Override with -e PORT.
EXPOSE 8300

CMD ["node", "bot.js"]
