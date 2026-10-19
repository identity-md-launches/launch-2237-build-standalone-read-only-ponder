FROM node:22.22.0-bookworm-slim
RUN npm install --global pnpm@10.34.7
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm codegen && pnpm typecheck && chown -R node:node /app
ENV NODE_ENV=production
EXPOSE 42069
USER node
CMD ["sh", "scripts/start.sh"]
