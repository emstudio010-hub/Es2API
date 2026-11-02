package telemetry

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
)

var osExecutable = os.Executable
var lookExecutable = osExecutable

const sidecarRestartWait = 5 * time.Minute

// StartIfEnabled execs `kin-worker telemetry --config ...` in its own
// process group. Failures are logged only — they never fail /v1.
func StartIfEnabled(ctx context.Context, cfg config.Config) {
	if !cfg.Telemetry.Enabled {
		return
	}
	if strings.TrimSpace(cfg.ConfigPath) == "" {
		return
	}
	go supervise(ctx, cfg)
}

func supervise(ctx context.Context, cfg config.Config) {
	for {
		if ctx.Err() != nil {
			return
		}
		cmd, err := startSidecar(cfg)
		if err != nil {
			log.Printf("telemetry sidecar: start failed")
		} else {
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			select {
			case <-ctx.Done():
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
				return
			case waitErr := <-done:
				if waitErr == nil {
					return
				}
				log.Printf("telemetry sidecar: exited")
			}
		}
		timer := time.NewTimer(sidecarRestartWait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func startSidecar(cfg config.Config) (*exec.Cmd, error) {
	exe, err := lookExecutable()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, "telemetry", "--config", cfg.ConfigPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = sidecarSysProcAttr()
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}
