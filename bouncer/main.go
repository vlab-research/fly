package main

import (
	"log"
	"os"

	"github.com/labstack/echo/v4"
	"github.com/vlab-research/bouncer/methods/auto"
	"github.com/vlab-research/bouncer/methods/captcha"
	"github.com/vlab-research/bouncer/verify"
)

func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		log.Fatalf("[BOUNCER_CONFIG] %s is not set", name)
	}
	return v
}

// registry is the one place that knows which methods and providers this
// deployment offers.
func registry() verify.Registry {
	turnstile := captcha.NewTurnstile(
		mustEnv("TURNSTILE_SITE_KEY"),
		mustEnv("TURNSTILE_SECRET_KEY"),
		mustEnv("BOUNCER_HOSTNAME"),
	)

	r := verify.Registry{
		"captcha": captcha.New(turnstile),
	}

	if os.Getenv("BOUNCER_ALLOW_AUTO") == "true" {
		log.Printf("[BOUNCER_AUTO_ENABLED] the `auto` method is offered: links requesting it verify with no participant action")
		r["auto"] = auto.Method{}
	}
	return r
}

func main() {
	server := &Server{
		HMACKey: []byte(mustEnv("BOUNCER_HMAC_KEY")),
		Methods: registry(),
		Sender:  NewEventer(mustEnv("BOTSERVER_URL")),
	}

	e := echo.New()
	e.GET("/verify", server.page)
	e.POST("/verify/submit", server.submit)
	e.GET("/health", server.health)

	e.Logger.Fatal(e.Start(":1323"))
}
