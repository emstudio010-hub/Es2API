//go:build !linux

package egress

import (
	"fmt"
	"net"
)

func OriginalDst(net.Conn) (string, error) {
	return "", fmt.Errorf("SO_ORIGINAL_DST is linux-only")
}
