FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY scripts ./scripts
RUN mkdir -p /app/data && \
    adduser --disabled-password --no-create-home --gecos "" appuser && \
    chown -R appuser:appuser /app/data
ENV MEET_STORAGE=/app/data/meet.lxf
ENV MEET_TEMPLATE=/app/templates/meet.lxf
USER appuser
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
