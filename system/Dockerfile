FROM golang:1.24-alpine

RUN mkdir /app
COPY go.mod /app
WORKDIR /app

RUN go mod download
