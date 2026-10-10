# Tab: long-running Node process (Photon gRPC stream + Hono web + SQLite).
# Deploy anywhere that runs a container with a persistent disk mounted at /app/data
# (Railway: attach a volume at that path; a Dockerfile VOLUME line is rejected there).
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 and sharp ship prebuilt linux binaries, so no compiler toolchain is needed.
# tsx is a devDependency and we run TypeScript directly with it, so install everything.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/tab.db
EXPOSE 3000

CMD ["npm", "start"]
