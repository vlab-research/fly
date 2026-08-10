# media-proxy: a static binary on a scratch-adjacent base.
#
# No CGO, so unlike scribble and message-worker this needs no librdkafka and no
# musl toolchain -- the service talks HTTP and S3 and nothing else.
FROM golang:1.26-alpine AS build

WORKDIR /build

# Dependencies first, so a source edit does not re-download the module cache.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o media-proxy .

FROM alpine:3.22

# ca-certificates so an https:// S3_ENDPOINT can be verified.
RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=build /build/media-proxy /app/

RUN adduser -D -u 1000 proxy
USER proxy

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O- http://localhost:8080/health || exit 1

CMD ["/app/media-proxy"]
