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

        if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
          const directSocket = net.connect(port, host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length > 0) directSocket.write(head);
            clientSocket.pipe(directSocket);
            directSocket.pipe(clientSocket);
          });
          directSocket.on('error', () => clientSocket.end());
          clientSocket.on('error', () => directSocket.end());
          return;
        }

        const proxySocket = net.connect(this.socksPort, '127.0.0.1', () => {
          proxySocket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

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

      this.server.on('error', reject);
      this.server.listen(15666, '127.0.0.1', () => {
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
