# AFC im Internet (Railway, Render o. ä.). Auf dem Mac wird dieses Dockerfile nicht gebraucht.
FROM node:22-bookworm-slim

# Das Image bringt tzdata (Zeitzone Zürich) und tar (Umzug vom Mac, lib/umzug.js) schon mit.
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Europe/Zurich \
    AFC_DATA_DIR=/app/data \
    AFC_HOSTED=1 \
    AFC_SERVER=1 \
    AFC_UPDATE_CHECK=0 \
    AFC_BACKTEST_AUTO=1 \
    AFC_BACKUP_DIR= \
    AFC_TRUSTED_PROXY_HOPS=1 \
    PORT=8787
# PORT ist nur ein Rückfall: Railway/Render setzen ihn zur Laufzeit, der Server übernimmt die Variable.

# Alles ausser dem, was in .dockerignore steht (Daten, Tests, Mac-Werkzeuge)
COPY . .
RUN mkdir -p /app/data/backups

# BEWUSST KEIN "USER node":
# Volume-Mounts (Railway Volume, Render Disk) auf /app/data gehören beim ersten Start root. Ein unprivilegierter
# Prozess bekommt dort EACCES, stirbt vor dem listen() und die Plattform meldet einen Healthcheck-Fehler, ohne dass
# je ein Port offen war. Wer non-root will, muss das Volume vorher per Init-Container/Entrypoint chownen.

EXPOSE 8787
CMD ["node", "server.js"]
