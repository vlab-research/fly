# MinIO image

Our own build of the MinIO community edition, which backs `storage-api.vlab.digital`
(Fly exports) and `media.vlab.digital` (survey media) through the `minio`
StatefulSet in the `minio` namespace.

MinIO no longer distributes the community edition: the GitHub repo was archived
in April 2026 and is source-only, Docker Hub images were deleted in September
2026, and `quay.io/minio/minio` and `dl.min.io` now refuse old releases. Any node
without a cached image cannot start MinIO, which is what took storage down on
2026-10-05 after the GKE nodes were replaced.

So we build the exact release we run from its source tag and pull it from our own
registry:

    devops/minio/image/build.sh RELEASE.2025-09-07T16-13-09Z --push

`build.sh` clones the tag into `src/`, which is gitignored: MinIO's source is
fetched at build time and never committed. It builds `Dockerfile`, prints
`minio --version` to check the stamped release and commit, and with `--push`
pushes to `us-west1-docker.pkg.dev/toixotoixo/vlab-research/minio:<tag>`. Then
pin the new digest in `devops/minio/minio.yaml` and `kubectl apply -f devops/minio/`.

`Dockerfile` follows upstream's `Dockerfile.release` (ubi-micro base, same
entrypoint and environment) with a source build in place of the binary download,
and the version flags from `buildscripts/gen-ldflags.go`.

The community code gets no more security fixes. Longer term: AIStor (paid for a
multi-node cluster) or a move to another S3 server such as SeaweedFS or Garage.

## Builds

| Release | Commit | Image digest |
|---|---|---|
| RELEASE.2025-09-07T16-13-09Z | 07c3a429bfed433e49018cb0f78a52145d4bedeb | sha256:09b37fa91ec6766eeaa0ef57c7ea3c4d1c8aee30ec96280b1ee38d4b2253d609 |
