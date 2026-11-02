//go:build unix

package telemetry

import "syscall"

func sidecarSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
