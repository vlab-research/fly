# DinersClub Environment Configuration Setup - Findings

**Date**: 2026-03-01
**Task**: Set up `.env` and `.env-ding` configuration files for the DinersClub payment processing service

## Summary

Successfully created environment configuration files for the DinersClub Kafka-based payment processing service. The project uses Go's `caarlos0/env` package for environment variable parsing, and does not rely on shell-based `.env` sourcing.

## Environment Loading Architecture

### Current Implementation

**File**: `/home/nandan/Documents/vlab-research/fly/dinersclub/config.go` (lines 33-38)

```go
type Config struct {
    // ... 30+ fields ...
}

func getConfig() *Config {
    cfg := Config{}
    err := env.Parse(&cfg)
    handle(err)
    return &cfg
}
```

**Key Findings**:
1. The `caarlos0/env/v6` package directly parses environment variables from the process environment
2. There is no automatic `.env` file loading in the Go code — the program expects env vars to be set before execution
3. Environment variables are marked with struct tags: `env:"VARIABLE_NAME,required"` or `env:"VARIABLE_NAME" envDefault:"value"`
4. No existing `.env` file was present in the dinersclub directory before this work

### How Environment Files Are Used

In deployment scenarios:

1. **Docker Runtime**: Pass env files via `--env-file` flag:
   ```bash
   docker run --env-file dinersclub/.env --env-file dinersclub/.env-ding dinersclub:latest
   ```

2. **Docker Compose**: Specify multiple env files in service definition:
   ```yaml
   services:
     dinersclub:
       env_file:
         - .env
         - .env-ding
   ```

3. **Kubernetes**: Use ConfigMaps and Secrets:
   - Non-sensitive vars: ConfigMaps loaded via `envFrom`
   - Sensitive vars (like API keys): Kubernetes Secrets

4. **Local Development**: Manually export variables or use a shell script:
   ```bash
   source dinersclub/.env
   source dinersclub/.env-ding
   go run .
   ```

**Important**: Shell `source` works for local development but NOT in Docker containers without additional tooling. Docker's `--env-file` is the correct approach.

## Files Created

### 1. `/home/nandan/Documents/vlab-research/fly/dinersclub/.env-ding`

**Purpose**: Contains sensitive API credentials
**Contents**: Single line with DINGCONNECT API key
**Security**: Added to `.gitignore` — must never be committed

```
DINGCONNECT_API_KEY=FtzZtnTRhBe5l4KYxRxK2r
```

### 2. `/home/nandan/Documents/vlab-research/fly/dinersclub/.env`

**Purpose**: Contains non-sensitive configuration defaults
**Size**: 1,128 bytes with comments
**Contents**:
- Database configuration (CockroachDB defaults for local dev)
- Kafka broker and topic configuration
- Payment provider settings (cache, retry, pool size)
- Provider flags (RELOADLY_SANDBOX=true for testing)
- BotServer endpoint
- Inline comments explaining dual env file usage

**Key Design Decision**: The `.env` file documents in comments that `.env-ding` should be included alongside it, since Go doesn't support shell-style `source` directives in plain `.env` files.

### 3. `/home/nandan/Documents/vlab-research/fly/dinersclub/.gitignore`

**Purpose**: Prevent accidental commits of secret files
**Key Rules**:
- `.env-ding` — prevents secret API key file commits
- `.env-*.local` — allows team members to use `.env-local` for personal overrides
- Build artifacts (`/dinersclub` binary, `*.o`, `*.a`)
- Go cache and vendor directories
- IDE config files
- OS artifacts

## Configuration Structure

DinersClub requires 30+ environment variables organized by function:

| Category | Key Variables | Source |
|----------|---|---|
| **Database** | CHATBASE_{DATABASE,HOST,PORT,USER,MAX_CONNECTIONS} | `.env` |
| **Kafka** | KAFKA_{BROKERS,TOPIC,GROUP,POLL_TIMEOUT}, DINERSCLUB_BATCH_SIZE | `.env` |
| **Processing** | DINERSCLUB_{PROVIDERS,POOL_SIZE,RETRY_*} | `.env` |
| **Cache** | CACHE_{TTL,NUM_COUNTERS,MAX_COST,BUFFER_ITEMS} | `.env` |
| **Secrets** | DINGCONNECT_API_KEY (and future provider keys) | `.env-ding` |
| **Optional** | BACK_OFF_RANDOM_FACTOR, RELOADLY_SANDBOX | `.env` |

All variables marked `required` in struct tags will cause fatal error if missing (see config.go lines 10-25).

## Usage Patterns

### For Docker Deployment

```bash
# Build
docker build -f Dockerfile -t dinersclub:latest .

# Run with env files
docker run \
  --env-file dinersclub/.env \
  --env-file dinersclub/.env-ding \
  --network host \
  dinersclub:latest
```

### For Docker Compose

```yaml
version: '3.8'
services:
  dinersclub:
    build:
      context: ./dinersclub
      dockerfile: Dockerfile
    env_file:
      - ./dinersclub/.env
      - ./dinersclub/.env-ding
    depends_on:
      - kafka
      - db
```

### For Local Development

```bash
cd dinersclub
export $(cat .env | grep -v '^#' | xargs)
export $(cat .env-ding | grep -v '^#' | xargs)
go run .
```

Or create a `.env-local` for personal overrides (not committed):
```bash
export $(cat .env | grep -v '^#' | xargs)
export $(cat .env-ding | grep -v '^#' | xargs)
export $(cat .env-local | grep -v '^#' | xargs)  # personal overrides
```

## Security Considerations

1. **`.env-ding` must never be committed** - Contains API key `FtzZtnTRhBe5l4KYxRxK2r`
   - Gitignore rule prevents accidental commits
   - Should be managed via: secrets manager, environment variables in CI/CD, or secure file sharing

2. **`.env` is safe to commit** - Contains only non-sensitive defaults and documentation
   - Local developers should override values for their environment
   - Use `.env-local` pattern for personal config not in version control

3. **No shell sourcing in Docker** - Plain `.env` files don't support `source` in containers
   - Documented in `.env` comments
   - Users must use `--env-file` flag or docker-compose `env_file` directive

## Related Files

- **README.md**: Line 7-44 documents required environment variables
- **main.go**: Lines 214-237 show how config is loaded at startup
- **config.go**: Lines 9-38 define Config struct and loading logic
- **test-env**: Example file used for testing (not auto-loaded)

## Deployment Checklist

Before deploying DinersClub:

- [ ] `.env` file with non-sensitive defaults (can be committed)
- [ ] `.env-ding` file with `DINGCONNECT_API_KEY` (never commit)
- [ ] `.gitignore` configured to exclude `.env-ding`
- [ ] Docker build command includes both env files: `--env-file .env --env-file .env-ding`
- [ ] Or docker-compose.yml specifies both in `env_file` list
- [ ] All required variables present (see config.go struct tags)
- [ ] `BOTSERVER_URL` points to correct environment (localhost for dev, actual URL for prod)
- [ ] `KAFKA_BROKERS` points to correct cluster
- [ ] `RELOADLY_SANDBOX` set appropriately (true for dev/test, false for production)

## Notes

- The `.env` file provides sensible defaults for local development (CockroachDB on localhost, fake providers)
- Production deployments should override via environment or secrets management
- No custom env file loading library needed — Go's `caarlos0/env` handles everything
- Multiple env files are loaded sequentially by Docker/docker-compose (last value wins on conflicts)
