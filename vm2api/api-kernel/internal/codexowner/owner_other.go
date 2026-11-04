//go:build !linux

package codexowner

// Kernel ownership is supported only on Linux; never launch without the flock.
func Run(_ []string) int { return 78 }
