FROM golang:alpine

RUN apk add curl

RUN mkdir /app
COPY go.mod /app
WORKDIR /app

RUN go mod download
