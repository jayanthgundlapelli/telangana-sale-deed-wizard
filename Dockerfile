# =============================================================================
# Telangana Sale Deed Wizard — production image
# Multi-stage build: compile the Vite SPA + bundle the Express server, then ship
# a slim runtime image with only production dependencies.
#
# Works on any container host: Google Cloud Run, Render, Railway, Fly.io, Koyeb.
# The host injects PORT; the server reads process.env.PORT (defaults to 3000).
# =============================================================================

# ---- Build stage -----------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Install ALL deps (incl. dev) so vite/esbuild/tsx are available for the build.
COPY package*.json ./
RUN npm ci

# Build the client (dist/assets + dist/index.html) and the server (dist/server.cjs).
COPY . .
RUN npm run build

# ---- Runtime stage ---------------------------------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Only production dependencies are needed at runtime — the server bundle keeps
# npm packages external (see the esbuild --packages=external flag).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bundled server + built client assets.
COPY --from=builder /app/dist ./dist

# Deed templates (.docx) are read from ./templates at runtime. Ship them in the
# image so user-supplied templates survive; the server also self-seeds if empty.
COPY --from=builder /app/templates ./templates

# Render/Cloud Run/Railway override this with their own PORT.
EXPOSE 3000

# Liveness probe hits the app's own health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
