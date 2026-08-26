FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json /build/package-lock.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=root:root entrypoint.sh /usr/local/bin/mail-broker-entrypoint
RUN mkdir -p /data && chown node:node /data
RUN chmod 0755 /usr/local/bin/mail-broker-entrypoint

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/mail-broker-entrypoint"]
