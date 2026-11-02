//go:build linux

package egress

import (
	"encoding/binary"
	"fmt"
	"net"
	"unsafe"

	"golang.org/x/sys/unix"
)

const soOriginalDst = 80

func OriginalDst(conn net.Conn) (string, error) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return "", fmt.Errorf("original dest requires TCP, got %T", conn)
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return "", err
	}
	var (
		addr   unix.RawSockaddrInet4
		sysErr error
	)
	ctlErr := raw.Control(func(fd uintptr) {
		size := uint32(unsafe.Sizeof(addr))
		_, _, errno := unix.Syscall6(
			unix.SYS_GETSOCKOPT,
			fd,
			uintptr(unix.IPPROTO_IP),
			uintptr(soOriginalDst),
			uintptr(unsafe.Pointer(&addr)),
			uintptr(unsafe.Pointer(&size)),
			0,
		)
		if errno != 0 {
			sysErr = errno
		}
	})
	if ctlErr != nil {
		return "", ctlErr
	}
	if sysErr != nil {
		return "", sysErr
	}
	ip := net.IPv4(addr.Addr[0], addr.Addr[1], addr.Addr[2], addr.Addr[3])
	port := int(binary.BigEndian.Uint16((*[2]byte)(unsafe.Pointer(&addr.Port))[:]))
	if ip.IsUnspecified() || port <= 0 {
		return "", fmt.Errorf("empty original destination")
	}
	return net.JoinHostPort(ip.String(), fmt.Sprintf("%d", port)), nil
}
