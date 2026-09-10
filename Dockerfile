# Production image for Cloud Run: SPA + proxy in one process.
FROM node:22-bookworm AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN npx ng build --configuration=production --output-path=/out

FROM node:22-bookworm
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY chat-server/package.json chat-server/package-lock.json ./
RUN npm ci --omit=dev
COPY chat-server/ ./
COPY --from=web /out/browser ./public
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
