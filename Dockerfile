# ---- Base image ----
FROM node:22-slim AS base
WORKDIR /app

# ---- Install dependencies ----
# Copy only package files first so Docker can cache this layer
# and skip re-installing deps when only your source code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- Copy application source ----
COPY . .

# ---- Runtime config ----
# Your server.js reads process.env.PORT, defaulting to 4000.
# Fly's fly.toml should point internal_port at this same value.
ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# ---- Start the app ----
CMD ["node", "server.js"]