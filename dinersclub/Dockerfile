FROM golang:alpine3.16 AS build
RUN apk add --no-cache \
        gcc \
        libc-dev \
        librdkafka-dev=1.8.2-r0 \
        pkgconf
RUN mkdir /app
WORKDIR /app

COPY go.mod .
COPY go.sum .
RUN go mod download
COPY . /app/
RUN go build -tags dynamic -a -o main .


FROM alpine:3.16
RUN apk add --no-cache librdkafka-dev=1.8.2-r0
WORKDIR /app
COPY --from=build /app/main /app/
CMD ["/app/main"]
