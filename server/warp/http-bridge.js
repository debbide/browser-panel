const http = require('http');
const net = require('net');

class HttpSocksBridge {
  constructor(socksPort, httpPort = 15666) {
    this.socksPort = socksPort;
    this.preferredHttpPort = httpPort;
    this.httpPort = null;
    this.server = null;
    this.sockets = new Set();
  }

  isRunning() {
    return Boolean(this.server) && Number.isInteger(this.httpPort);
  }

  trackSocket(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    return socket;
  }

  async start() {
    if (this.server) return this.httpPort;

    return new Promise((resolve, reject) => {
      // Only publish this.server after listen succeeds: a failed listen must
      // not leave a stale server behind that makes the next start() return
      // a null port.
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url);
          if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '0.0.0.0') {
            const proxyReq = http.request({
              hostname: url.hostname,
              port: url.port || 80,
              path: url.pathname + url.search,
              method: req.method,
              headers: req.headers
            }, (proxyRes) => {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              proxyRes.pipe(res);
            });
            proxyReq.on('error', () => {
              res.writeHead(502);
              res.end('Bad Gateway');
            });
            req.pipe(proxyReq);
            return;
          }
        } catch (e) {
          // invalid url
        }
        res.writeHead(405);
        res.end('Proxy bridge only supports CONNECT');
      });

      server.on('connect', (req, clientSocket, head) => {
        const [host, portStr] = (req.url || '').split(':');
        const port = parseInt(portStr, 10);
        if (!host || !port) {
          return clientSocket.end();
        }

        if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
          const directSocket = this.trackSocket(net.connect(port, host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) directSocket.write(head);
            clientSocket.pipe(directSocket);
            directSocket.pipe(clientSocket);
          }));
          directSocket.on('error', () => clientSocket.end());
          clientSocket.on('error', () => directSocket.end());
          return;
        }

        const proxySocket = this.trackSocket(net.connect(this.socksPort, '127.0.0.1', () => {
          proxySocket.write(Buffer.from([0x05, 0x01, 0x00]));
        }));

        let step = 0;
        let buffer = Buffer.alloc(0);

        const onData = (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);

          if (step === 0) {
            if (buffer.length < 2) return;
            if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
              clientSocket.end();
              return;
            }
            buffer = buffer.slice(2);
            step = 1;
            
            const hostLen = Buffer.byteLength(host);
            const reqBuf = Buffer.alloc(4 + 1 + hostLen + 2);
            reqBuf[0] = 0x05; reqBuf[1] = 0x01; reqBuf[2] = 0x00; reqBuf[3] = 0x03;
            reqBuf[4] = hostLen;
            reqBuf.write(host, 5);
            reqBuf.writeUInt16BE(port, 5 + hostLen);
            proxySocket.write(reqBuf);
          }

          if (step === 1) {
            if (buffer.length < 4) return;
            const atyp = buffer[3];
            let expectedLen = 0;
            if (atyp === 1) expectedLen = 10;
            else if (atyp === 4) expectedLen = 22;
            else if (atyp === 3) expectedLen = 5 + buffer[4];
            else {
              clientSocket.end();
              return;
            }

            if (buffer.length < expectedLen) return;
            
            if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
              clientSocket.end();
              return;
            }

            const leftover = buffer.slice(expectedLen);
            step = 2;
            proxySocket.removeListener('data', onData);

            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (leftover.length > 0) {
              clientSocket.write(leftover);
            }
            if (head && head.length > 0) {
              proxySocket.write(head);
            }
            
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
          }
        };

        proxySocket.on('data', onData);
        proxySocket.on('error', () => clientSocket.end());
        clientSocket.on('error', () => proxySocket.end());
      });

      // Track live sockets so stop() can destroy long-lived CONNECT tunnels;
      // server.close() alone would wait for them forever.
      const bridge = this;
      server.on('connection', (socket) => bridge.trackSocket(socket));
      // If the server dies on its own, clear state promptly so the manager
      // never reports a dead bridge as available.
      server.on('close', () => {
        if (this.server === server) {
          this.server = null;
          this.httpPort = null;
        }
      });
      server.once('error', (error) => {
        // A listen failure must not leave a stale server behind.
        try { server.close(); } catch { /* ignore */ }
        reject(error);
      });
      server.listen(this.preferredHttpPort, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', (error) => {
          console.error('[warp] HTTP bridge error:', error && error.message);
        });
        this.server = server;
        this.httpPort = server.address().port;
        resolve(this.httpPort);
      });
    });
  }

  async stop() {
    const server = this.server;
    if (!server) return;
    // Clear state first: from this point on the bridge is not available.
    this.server = null;
    this.httpPort = null;
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sockets.clear();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      timer.unref?.();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { HttpSocksBridge };
