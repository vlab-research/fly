// Command media-proxy is the sole public read path for media assets.
//
// It serves exactly one shape of URL -- /a/<uuid>[/<filename>] -- from a
// private object-storage bucket, over the S3 API, with server-set headers and
// no database. See README.md and planning/media-abstraction.md §4.4.
package main

import (
	"net/http"
	"time"

	"go.uber.org/zap"

	"github.com/vlab-research/fly/media-proxy/internal/media"
)

func main() {
	logger, err := zap.NewProduction()
	if err != nil {
		panic(err)
	}
	defer logger.Sync()

	cfg, err := LoadConfigFromEnv()
	if err != nil {
		logger.Fatal("configuration error", zap.Error(err))
	}

	store, err := media.NewS3Store(cfg.S3)
	if err != nil {
		logger.Fatal("could not reach object storage", zap.Error(err))
	}

	handler := media.NewHandler(store, cfg.Prefix, logger)

	// Deliberately NOT http.ServeMux. ServeMux cleans and redirects paths
	// before a handler sees them, which would mean a traversal attempt got a
	// 301 from the router rather than a rejection from the path contract --
	// correct by accident, and untrue the day the router changes. Routing here
	// is two lines and the handler sees the raw path.
	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /health never touches storage, so it is a liveness signal for the
		// process rather than for MinIO. A proxy whose backend is down should
		// alert on 502 rate, not get killed and restarted by kubelet.
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("pong"))
			return
		}
		handler.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: root,
		// Generous write timeout: assets run to video size and a slow mobile
		// client on the far end of a Meta fetch is normal.
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}

	logger.Info("media-proxy listening",
		zap.String("port", cfg.Port),
		zap.String("bucket", cfg.S3.Bucket),
		zap.String("prefix", cfg.Prefix))

	if err := srv.ListenAndServe(); err != nil {
		logger.Fatal("server stopped", zap.Error(err))
	}
}
