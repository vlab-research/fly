FROM golang:1.23-alpine AS build
RUN apk add --no-cache \
        gcc \
        libc-dev
RUN mkdir /app
WORKDIR /app

ADD go.mod .
ADD go.sum .
RUN go mod download
ADD . /app/
RUN go build -o exodus .


FROM alpine
WORKDIR /app
COPY --from=build /app/exodus /app/

ENTRYPOINT ["/app/exodus"]
CMD ["--mode=executor"]
