# Multi-stage build for Go message-worker
# Stage 1: Builder
FROM golang:1.25-alpine AS builder

# Install build dependencies for librdkafka from edge repository
RUN apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community \
    gcc \
    musl-dev \
    librdkafka-dev \
    pkgconf \
    git

WORKDIR /build

# Copy go mod files first for layer caching
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build with static linking
RUN CGO_ENABLED=1 GOOS=linux go build -tags dynamic \
    -ldflags="-w -s" \
    -o message-worker \
    ./cmd/message-worker

# Stage 2: Runtime
FROM alpine:edge

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    librdkafka \
    tzdata

WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/message-worker /app/

# Create non-root user
RUN adduser -D -u 1000 worker && \
    chown -R worker:worker /app

USER worker

# Health check (assumes worker exposes health endpoint on 8081)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD timeout 2 sh -c "echo > /dev/tcp/localhost/8081" || exit 1

# Expose health check port
EXPOSE 8081

# Set default environment variables
ENV LOG_LEVEL=info \
    HEALTH_PORT=8081

ENTRYPOINT ["/app/message-worker"]
