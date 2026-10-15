FROM python:3.11-slim

WORKDIR /usr/src/app

RUN apt-get update && \
    apt-get install --yes \
    curl \
    git \
    g++ && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip

RUN curl -sSL https://install.python-poetry.org | python3 -

ENV PATH="/root/.local/bin:$PATH"

RUN poetry config virtualenvs.create false

# Polars' jemalloc frees pages to the OS at once, lowering peak memory (README.md, "Memory").
ENV _RJEM_MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0

COPY poetry.lock pyproject.toml ./

RUN poetry install --only main --no-root

COPY . .

ENTRYPOINT ["python", "main.py"]
