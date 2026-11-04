//go:build linux

// Package codexowner keeps a slot's flock until the external kernel exits.
package codexowner

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

// Run receives only binary/config/lock paths, never tokens or proxy credentials.
// fd 3 is the same open file description locked by the admitting controller.
func Run(args []string) int {
	if len(args) != 3 {
		return 78
	}
	for _, arg := range args {
		if !filepath.IsAbs(arg) || filepath.Clean(arg) != arg {
			return 78
		}
	}
	lock := os.NewFile(3, "codex-kernel-owner")
	if lock == nil {
		return 78
	}
	defer lock.Close()
	held, err := lock.Stat()
	if err != nil || !held.Mode().IsRegular() {
		return 78
	}
	named, err := os.Lstat(args[2])
	if err != nil || !named.Mode().IsRegular() || !os.SameFile(held, named) {
		return 78
	}
	stat, ok := held.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || stat.Uid != uint32(os.Getuid()) {
		return 78
	}
	if syscall.Flock(3, syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return 73
	}
	// Linux ties Pdeathsig to the creating OS thread. Keep that thread alive
	// throughout Start/Wait; goroutine migration or thread retirement must not
	// kill a live kernel. If this owner dies, the direct kernel receives SIGKILL.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ch := make(chan os.Signal, 4)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(ch)
	cmd := exec.Command(args[0], args[1])
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = []*os.File{lock}
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL, Setpgid: true}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "codex_owner_spawn_failed")
		return 78
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	for {
		select {
		case sig := <-ch:
			_ = cmd.Process.Signal(sig)
		case err := <-done:
			if err == nil {
				return 0
			}
			if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() > 0 {
				return exit.ExitCode()
			}
			return 1
		}
	}
}
