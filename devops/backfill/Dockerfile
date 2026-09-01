# The messages account/platform backfill, as an image.
#
# ############################################################################
# THE BUILD CONTEXT IS `devops/`, NOT `devops/backfill/`.
#
#   docker build -f devops/backfill/Dockerfile devops/
#
# The tool reads its extraction rule at startup from devops/sql/*-expr.sql,
# which live OUTSIDE this directory, and Docker cannot reach above its context.
#
# DO NOT "FIX" THIS BY MOVING THE SQL FILES IN HERE. They are shared on purpose:
# scribble's TestBackfillSQLMatchesGo evaluates those exact files against the
# same fixture that pins hermes' Rust and replybot's JS (see the comment at
# backfill.go:7). A copy under devops/backfill/ breaks that test and creates a
# second definition of the rule that can silently diverge from the first --
# which is the precise failure this whole rollout exists to eliminate.
#
# go:embed is not a way out either: it cannot reach outside the module
# directory, and the module root is devops/backfill.
#
# .github/workflows/release.yml carries the matching `file:` input; it is the
# only service whose Dockerfile is not at <context>/Dockerfile.
# ############################################################################
FROM golang:1.24-alpine AS build
WORKDIR /app

ADD backfill/go.mod backfill/go.sum ./
RUN go mod download
ADD backfill/ /app/

# CGO_ENABLED=0, unlike dean's Dockerfile: pgx is pure Go, so there is nothing
# to link against and a static binary cannot pick up a libc mismatch between the
# golang and alpine base images.
RUN CGO_ENABLED=0 go build -o main .


FROM alpine
WORKDIR /app
COPY --from=build /app/main /app/
COPY sql/ /app/sql/

# ENTRYPOINT, not CMD, so the Job template supplies only arguments and cannot
# accidentally replace the command with something else.
#
# --sql-dir MUST be passed as /app/sql by the caller: its default is the literal
# relative path `devops/sql`, resolved against the working directory (main.go:74),
# which does not exist in this image.
ENTRYPOINT ["/app/main"]
