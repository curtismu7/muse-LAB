FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=5100 MODE=mock MUSE_HOSTED=1 MUSE_BIND=0.0.0.0
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts -w server
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
# Where MUSE_CLIENTS_FILE may point: owned by the app user so registrations can be saved.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 5100
# Publish on loopback only: docker run -p 127.0.0.1:5100:5100 ...
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:5100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
