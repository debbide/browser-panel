const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const { createS3Client } = require('../../server/cloud/s3-client');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-f7s3-'));
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pageXml({ objects, truncated, nextToken }) {
  const contents = objects
    .map((o) => `<Contents><Key>${o.key}</Key><Size>${o.size}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>` +
    contents +
    (nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '') +
    `</ListBucketResult>`;
}

test.before(async () => {
  // Self-signed CA + server cert so the client's curl/fetch path can talk to
  // a local HTTPS stub.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(tmp, 'ca.key'), '-out', path.join(tmp, 'ca.crt'),
    '-days', '1', '-subj', '/CN=browser-panel-test-ca'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(tmp, 'srv.key'), '-out', path.join(tmp, 'srv.csr'),
    '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(tmp, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\n');
  execFileSync('openssl', ['x509', '-req', '-in', path.join(tmp, 'srv.csr'),
    '-CA', path.join(tmp, 'ca.crt'), '-CAkey', path.join(tmp, 'ca.key'),
    '-CAcreateserial', '-days', '1', '-out', path.join(tmp, 'srv.crt'),
    '-extfile', path.join(tmp, 'ext.cnf')], { stdio: 'ignore' });
  process.env.CURL_CA_BUNDLE = path.join(tmp, 'ca.crt');
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});

test('F7: listObjects follows continuation tokens until IsTruncated=false', async (t) => {
  const seenQueries = [];
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(tmp, 'srv.key')),
      cert: fs.readFileSync(path.join(tmp, 'srv.crt')),
    },
    (req, res) => {
      const url = new URL(req.url, 'https://127.0.0.1');
      seenQueries.push(url.searchParams);
      const token = url.searchParams.get('continuation-token');
      // Verify SigV4 query-param ordering is preserved with the new param.
      const rawQuery = req.url.split('?')[1] || '';
      const keys = rawQuery.split('&').map((p) => p.split('=')[0]);
      const sorted = [...keys].sort();
      assert.deepEqual(keys, sorted, 'query params must stay sorted for SigV4');

      let xml;
      if (!token) {
        xml = pageXml({
          objects: [{ key: 'backups/a.zip', size: 10 }, { key: 'backups/b.zip', size: 20 }],
          truncated: true,
          nextToken: 'token-abc-123',
        });
      } else if (token === 'token-abc-123') {
        xml = pageXml({
          objects: [{ key: 'backups/c.zip', size: 30 }],
          truncated: false,
        });
      } else {
        res.writeHead(400);
        res.end('unexpected continuation-token');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(xml);
    }
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const client = createS3Client({
    endpoint: `https://127.0.0.1:${port}`,
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKey: 'ak',
    secretKey: 'sk',
    pathStyle: true,
  });

  const objects = await client.listObjects({ prefix: 'backups/', maxKeys: 2 });
  assert.equal(objects.length, 3, 'must aggregate all pages, not just the first 1000/maxKeys');
  assert.deepEqual(objects.map((o) => o.key), ['backups/a.zip', 'backups/b.zip', 'backups/c.zip']);
  assert.equal(seenQueries.length, 2, 'expected exactly two LIST requests');
  assert.equal(seenQueries[1].get('continuation-token'), 'token-abc-123');
});

test('F7: listObjects stops after a single page when not truncated', async (t) => {
  let requests = 0;
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(tmp, 'srv.key')),
      cert: fs.readFileSync(path.join(tmp, 'srv.crt')),
    },
    (req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(pageXml({ objects: [{ key: 'x.zip', size: 1 }], truncated: false }));
    }
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const client = createS3Client({
    endpoint: `https://127.0.0.1:${server.address().port}`,
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKey: 'ak',
    secretKey: 'sk',
    pathStyle: true,
  });
  const objects = await client.listObjects({});
  assert.equal(objects.length, 1);
  assert.equal(requests, 1, 'no extra page fetches when IsTruncated=false');
});
