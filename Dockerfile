# DabbaTrack API + PWA. Python standard library only, so there's nothing to pip install.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Kolkata \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/tiffin.db \
    BACKUP_DIR=/data/backups

# tzdata so TZ=Asia/Kolkata takes effect: meal cutoffs and "today" follow this clock.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app \
    && mkdir -p /data \
    && chown app:app /data

WORKDIR /app
COPY --chown=app:app db.py server.py qr.py push.py backup.py ./
COPY --chown=app:app static ./static

USER app
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8080'), timeout=4)"]

# Exec form so the server is PID 1 and receives SIGTERM from `docker stop` (graceful shutdown).
CMD ["python", "server.py"]
