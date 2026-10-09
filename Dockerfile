FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV AFC_DATA_DIR=/app/data
# Fallback-Port. Railway/Render überschreiben PORT zur Laufzeit; der Server übernimmt die Variable.
ENV PORT=8787

COPY package.json server.js index.html app.js app.css manifest.json sw.js privacy.html README.md ./
COPY lib ./lib
COPY icon-192.png icon-512.png ./

RUN mkdir -p /app/data/backups

# BEWUSST KEIN "USER node":
# Volume-Mounts (Railway Volume, Render Disk) auf /app/data gehören beim ersten Start root. Ein unprivilegierter
# Prozess bekommt dort EACCES, stirbt vor dem listen() und die Plattform meldet einen Healthcheck-Fehler, ohne dass
# je ein Port offen war. Wer non-root will, muss das Volume vorher per Init-Container/Entrypoint chownen.

EXPOSE 8787

CMD ["node", "server.js"]
