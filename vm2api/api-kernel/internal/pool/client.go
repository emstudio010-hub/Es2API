package pool

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

const (
	maxIdleConns        = 4096
	maxIdleConnsPerHost = 2048
	maxConnsPerHost     = 8192
	idleConnTimeout     = 90 * time.Second
	dialTimeout         = 10 * time.Second
	tlsHandshakeTimeout = 10 * time.Second
	responseHeaderWait  = 300 * time.Second
)

type Manager struct {
	mu      sync.Mutex
	clients map[string]*http.Client
}

func NewManager() *Manager {
	return &Manager{clients: make(map[string]*http.Client)}
}

func (m *Manager) Client(proxyURL string) (*http.Client, error) {
	key := proxyURL
	if key == "" || key == "direct" {
		key = "direct"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.clients[key]; ok {
		return c, nil
	}
	c, err := newClient(key)
	if err != nil {
		return nil, err
	}
	m.clients[key] = c
	return c, nil
}

func newClient(proxyKey string) (*http.Client, error) {
	dialer := &net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          maxIdleConns,
		MaxIdleConnsPerHost:   maxIdleConnsPerHost,
		MaxConnsPerHost:       maxConnsPerHost,
		IdleConnTimeout:       idleConnTimeout,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ResponseHeaderTimeout: responseHeaderWait,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if proxyKey != "" && proxyKey != "direct" {
		u, err := url.Parse(proxyKey)
		if err != nil {
			return nil, err
		}
		if u.Scheme == "socks5" || u.Scheme == "socks5h" {
			auth := &proxy.Auth{}
			if u.User != nil {
				auth.User = u.User.Username()
				auth.Password, _ = u.User.Password()
			}
			var socksAuth *proxy.Auth
			if u.User != nil {
				socksAuth = auth
			}
			d, err := proxy.SOCKS5("tcp", u.Host, socksAuth, dialer)
			if err != nil {
				return nil, err
			}
			contextDialer, ok := d.(proxy.ContextDialer)
			if ok {
				transport.DialContext = contextDialer.DialContext
			} else {
				transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
					return d.Dial(network, addr)
				}
			}
		} else {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	return &http.Client{Transport: transport, Timeout: 0, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}, nil
}
