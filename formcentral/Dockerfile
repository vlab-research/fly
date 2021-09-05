FROM golang:alpine

RUN apk add --no-cache \
    bash \
    gcc \
    libc-dev

RUN mkdir /app
WORKDIR /app

COPY go.mod .
COPY go.sum .
RUN go mod download

COPY . /app
RUN go build -o main .
