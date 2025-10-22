FROM golang:1.24-alpine AS build
RUN apk add --no-cache \
        gcc \
        libc-dev \
        librdkafka-dev \
        pkgconf
RUN mkdir /app
WORKDIR /app

COPY go.mod .
COPY go.sum .
RUN go mod download
COPY . /app/
RUN go build -tags dynamic -a -o main .


FROM alpine:latest
RUN apk add --no-cache librdkafka-dev
WORKDIR /app
COPY --from=build /app/main /app/
CMD ["/app/main"]
