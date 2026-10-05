# MinIO community edition built from a release tag; see README.md.
FROM golang:1.24-alpine AS build

ARG RELEASE

RUN apk add -U --no-cache ca-certificates

WORKDIR /src
COPY . .

# The same -X flags buildscripts/gen-ldflags.go sets for an official release;
# .git is outside the build context, so the commit comes in as an argument.
ARG COMMIT
RUN VERSION=$(echo "${RELEASE}" | sed -E 's/RELEASE\.([0-9]+-[0-9]+-[0-9]+)T([0-9]+)-([0-9]+)-([0-9]+)Z/\1T\2:\3:\4Z/') && \
    P=github.com/minio/minio/cmd && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags kqueue -trimpath -o /out/minio --ldflags "-s -w \
      -X $P.Version=${VERSION} -X $P.CopyrightYear=${VERSION%%-*} -X $P.ReleaseTag=${RELEASE} \
      -X $P.CommitID=${COMMIT} -X $P.ShortCommitID=$(echo ${COMMIT} | cut -c1-12)"

FROM registry.access.redhat.com/ubi9/ubi-micro:latest

ARG RELEASE

LABEL name="MinIO" version="${RELEASE}" release="${RELEASE}"

ENV MINIO_ACCESS_KEY_FILE=access_key \
    MINIO_SECRET_KEY_FILE=secret_key \
    MINIO_ROOT_USER_FILE=access_key \
    MINIO_ROOT_PASSWORD_FILE=secret_key \
    MINIO_KMS_SECRET_KEY_FILE=kms_master_key \
    MINIO_CONFIG_ENV_FILE=config.env \
    MC_CONFIG_DIR=/tmp/.mc

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/minio /usr/bin/minio
COPY CREDITS /licenses/CREDITS
COPY LICENSE /licenses/LICENSE
COPY dockerscripts/docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
RUN chmod +x /usr/bin/minio /usr/bin/docker-entrypoint.sh

EXPOSE 9000
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
