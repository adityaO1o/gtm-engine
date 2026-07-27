# --- Stage 1: build the Next.js dashboard (static export -> web/out) ---
FROM node:20-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# --- Stage 2: backend runtime (serves /api + the static UI) ---
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Bring in the built dashboard; served when USE_NEXT_UI=1 (else the vanilla public/ is served).
COPY --from=web /web/out ./web/out

# Deployed commit, surfaced at GET /health. Passed as a build arg (see docker-compose.yml). Defaults
# to "unknown" — .git is dockerignored so it can't be read from the source tree at build time.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

ENV PORT=3001
EXPOSE 3001
CMD ["node", "src/server.js"]
