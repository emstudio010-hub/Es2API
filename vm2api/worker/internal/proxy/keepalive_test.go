package proxy

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestApplyTCPKeepAliveOnTCPConn(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, acceptErr := ln.Accept()
		if acceptErr != nil {
			return
		}
		defer c.Close()
		_, _ = io.Copy(io.Discard, c)
	}()
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ApplyTCPKeepAlive(conn)
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		t.Fatal("expected TCPConn")
	}
	if err = tcp.SetKeepAliveConfig(tcpKeepAlive); err != nil {
		t.Fatal(err)
	}
}

func TestApplyTCPKeepAliveIgnoresPipe(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	ApplyTCPKeepAlive(a)
}
