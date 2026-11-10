# Build the single-writer collaboration server without shipping credentials.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY backend ./backend
COPY src/domain ./src/domain
RUN npm run build:backend

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist-backend ./dist-backend
COPY scripts/backend ./scripts/backend
COPY package.json ./
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
EXPOSE 8787
CMD ["node", "dist-backend/backend/main.js"]
