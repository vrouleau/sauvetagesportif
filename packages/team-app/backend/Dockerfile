FROM python:3.12-slim
WORKDIR /app
COPY packages/team-app/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends mdbtools postgresql-client && rm -rf /var/lib/apt/lists/*
COPY packages/team-app/backend/app ./app
COPY packages/team-app/backend/scripts ./scripts
COPY config/combined-events-config.json .
COPY config/point-scores-config.json .
COPY config/template_pool.lxf ./templates/template_pool.lxf
COPY config/template_beach.lxf ./templates/template_beach.lxf
RUN mkdir -p /app/data && \
    adduser --disabled-password --no-create-home --gecos "" appuser && \
    chown -R appuser:appuser /app/data
ENV MEET_TEMPLATE_POOL=/app/templates/template_pool.lxf
ENV MEET_TEMPLATE_BEACH=/app/templates/template_beach.lxf
USER appuser
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
