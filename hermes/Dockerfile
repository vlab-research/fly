# Stage 1: install cargo-chef
# Track the latest stable 1.x toolchain: the current cargo-chef ships a v4
# Cargo.lock and depends on crates requiring edition2024 (stabilized in Rust
# 1.85), so the original pinned rust:1.75 can no longer `cargo install` it.
# The floating tag stays compatible with whatever cargo-chef it installs.
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

# Stage 2: compute dependency recipe (cache key)
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3: build dependencies, then the binary
FROM chef AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake build-essential libsasl2-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=planner /app/recipe.json recipe.json
# This layer is cached as long as Cargo.toml / Cargo.lock are unchanged
RUN cargo chef cook --release --recipe-path recipe.json

COPY . .
RUN cargo build --release --bin hermes

# Stage 4: minimal runtime image
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 libsasl2-2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/hermes /usr/local/bin/hermes

EXPOSE 8080
CMD ["hermes"]
