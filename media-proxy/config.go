package main

import (
	"fmt"
	"os"

	"github.com/vlab-research/fly/media-proxy/internal/media"
)

// Config is the whole configuration surface of the service. Every value comes
// from the environment (planning/media-abstraction.md §4.7); non-secret values
// are set in devops/values/<env>.yaml by helm, the two keys come from a
// gitignored .env via devops/secrets.sh. Nothing is set imperatively.
//
// There is no DATABASE_URL here, and that absence is the design. See README.md.
type Config struct {
	S3     media.S3Config
	Prefix string
	Port   string
}

// LoadConfigFromEnv reads and validates configuration.
//
// Everything required fails loudly at startup rather than on the first request:
// a media-proxy that boots healthy with the wrong bucket would serve 404s for
// every asset while looking fine to Kubernetes.
func LoadConfigFromEnv() (*Config, error) {
	cfg := &Config{
		S3: media.S3Config{
			Endpoint:        os.Getenv("S3_ENDPOINT"),
			Region:          getEnvOrDefault("S3_REGION", "us-east-1"),
			AccessKeyID:     os.Getenv("S3_ACCESS_KEY_ID"),
			SecretAccessKey: os.Getenv("S3_SECRET_ACCESS_KEY"),
			Bucket:          getEnvOrDefault("MEDIA_BUCKET", "media"),
		},
		Prefix: getEnvOrDefault("MEDIA_PREFIX", "a/"),
		Port:   getEnvOrDefault("PORT", "8080"),
	}

	for _, required := range []struct{ name, value string }{
		{"S3_ENDPOINT", cfg.S3.Endpoint},
		{"S3_ACCESS_KEY_ID", cfg.S3.AccessKeyID},
		{"S3_SECRET_ACCESS_KEY", cfg.S3.SecretAccessKey},
	} {
		if required.value == "" {
			return nil, fmt.Errorf("%s is required", required.name)
		}
	}

	return cfg, nil
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
