# syntax=docker/dockerfile:1
#
# Container build of the stdio MCP server, used by Glama to build, start and
# introspect the server, and available to anyone who runs the project in a
# container. The distribution channel stays npm; this image only runs the server.
#
# The transport is stdio, so no port is exposed. State lives in NOONIEN_DIR
# (`~/.noonien` by default) and every backend is reproduced from the environment.

# Build stage: compile the TypeScript sources with the full toolchain.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: `dist/` plus the production dependencies only.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
