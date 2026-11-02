package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
)

func TestStartIfEnabledDisabledIsNoop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lookExecutable = func() (string, error) {
		t.Fatal("disabled sidecar must not exec")
		return "", nil
	}
	t.Cleanup(func() { lookExecutable = osExecutable })
	StartIfEnabled(ctx, config.Config{
		Telemetry:  config.TelemetryConfig{Enabled: false},
		ConfigPath: "/tmp/worker.json",
	})
	time.Sleep(20 * time.Millisecond)
}

func TestStartIfEnabledMissingConfigPathIsNoop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lookExecutable = func() (string, error) {
		t.Fatal("empty config path must not exec")
		return "", nil
	}
	t.Cleanup(func() { lookExecutable = osExecutable })
	StartIfEnabled(ctx, config.Config{Telemetry: config.TelemetryConfig{Enabled: true}})
	time.Sleep(20 * time.Millisecond)
}
