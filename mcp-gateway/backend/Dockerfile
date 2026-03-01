FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution
RUN pip install uv --no-cache-dir

COPY pyproject.toml .
COPY app/ ./app/

RUN uv pip install --system --no-cache .

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
