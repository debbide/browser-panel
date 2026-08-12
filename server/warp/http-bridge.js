const http = require('http');
const net = require('net');

class HttpSocksBridge {
  constructor(socksPort) {
    this.socksPort = socksPort;
    this.httpPort = null;
    this.server = null;
  }

  async start() {
    if (this.server) return this.httpPort;
    
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.writeHead(405);
        res.end('Proxy bridge only supports CONNECT');
      });

      this.server.on('connect', (req, clientSocket, head) => {
        const [host, portStr] = (req.url || '').split(':');
        const port = parseInt(portStr, 10);
        if (!host || !port) {
          return clientSocket.end();
        }

        const proxySocket = net.connect(this.socksPort, '127.0.0.1', () => {
          proxySocket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let step = 0;
        proxySocket.on('data', (data) => {
          if (step === 0) {
            if (data[0] !== 0x05 || data[1] !== 0x00) {
              clientSocket.end();
              return;
            }
            step = 1;
            const hostLen = Buffer.byteLength(host);
            const reqBuf = Buffer.alloc(4 + 1 + hostLen + 2);
            reqBuf[0] = 0x05; reqBuf[1] = 0x01; reqBuf[2] = 0x00; reqBuf[3] = 0x03;
            reqBuf[4] = hostLen;
            reqBuf.write(host, 5);
            reqBuf.writeUInt16BE(port, 5 + hostLen);
            proxySocket.write(reqBuf);
          } else if (step === 1) {
            if (data[0] !== 0x05 || data[1] !== 0x00) {
              clientSocket.end();
              return;
            }
            step = 2;
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) {
              proxySocket.write(head);
            }
            clientSocket.pipe(proxySocket);
            proxySocket.pipe(clientSocket);
          }
        });

        proxySocket.on('error', () => clientSocket.end());
        clientSocket.on('error', () => proxySocket.end());
      });

      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.httpPort = this.server.address().port;
        resolve(this.httpPort);
      });
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        this.httpPort = null;
        resolve();
      });
    });
  }
}

module.exports = { HttpSocksBridge };
