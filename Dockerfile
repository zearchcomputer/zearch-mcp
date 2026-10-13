# zearch-mcp in Streamable HTTP mode, for a shared deployment such as mcp.zearch.computer.
# Callers authenticate with their own Zearch API key; this image holds no secrets.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# Set ZEARCH_MCP_ALLOWED_HOSTS to the public hostname(s) you serve.
CMD ["node", "dist/index.js", "--http", "--host", "0.0.0.0"]
