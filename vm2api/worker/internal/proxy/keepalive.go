package proxy

import (
	"net"
	"time"
)

// Keep the SOCKS TCP actually alive. Dialer.KeepAlive alone leaves Linux
// TCP_KEEPIDLE at 2h, so residential NAT drops the relay ~15min first.
var tcpKeepAlive = net.KeepAliveConfig{
	Enable:   true,
	Idle:     15 * time.Second,
	Interval: 15 * time.Second,
	Count:    3,
}

func ApplyTCPKeepAlive(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok || tcp == nil {
		return
	}
	_ = tcp.SetKeepAliveConfig(tcpKeepAlive)
}
