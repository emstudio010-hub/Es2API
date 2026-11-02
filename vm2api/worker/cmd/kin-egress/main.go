package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/egress"
)

func main() {
	configPath := flag.String("config", "", "path to egress JSON config")
	proxyURL := flag.String("socks", "", "socks5h URL (overrides config)")
	listenTCP := flag.String("listen", "", "tcp redirect listen addr")
	listenDNS := flag.String("dns", "", "udp dns listen addr")
	proxyID := flag.String("proxy-id", "", "proxy id for logs")
	flag.Parse()

	cfg := egress.Config{
		ProxyID:   *proxyID,
		ProxyURL:  *proxyURL,
		ListenTCP: *listenTCP,
		ListenDNS: *listenDNS,
	}
	if *configPath != "" {
		data, err := os.ReadFile(*configPath)
		if err != nil {
			log.Fatalf("read egress config: %v", err)
		}
		if err = json.Unmarshal(data, &cfg); err != nil {
			log.Fatalf("decode egress config: %v", err)
		}
		if *proxyURL != "" {
			cfg.ProxyURL = *proxyURL
		}
		if *listenTCP != "" {
			cfg.ListenTCP = *listenTCP
		}
		if *listenDNS != "" {
			cfg.ListenDNS = *listenDNS
		}
		if *proxyID != "" {
			cfg.ProxyID = *proxyID
		}
	}
	srv, err := egress.New(cfg)
	if err != nil {
		log.Fatalf("kin-egress: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err = srv.Serve(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "kin-egress serve: %v\n", err)
		os.Exit(1)
	}
}
