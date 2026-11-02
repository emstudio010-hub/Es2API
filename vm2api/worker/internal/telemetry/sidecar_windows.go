//go:build windows

package telemetry

import "syscall"

func sidecarSysProcAttr() *syscall.SysProcAttr {
	return nil
}
