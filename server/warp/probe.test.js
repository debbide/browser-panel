const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { runCurl, TARGETS } = require('./probe');

function successfulCurl(expectedTarget) {
  return (command, args) => {
    assert.equal(command, 'curl');
    assert.equal(args.includes('--ipv4'), false);
    assert.equal(args.includes('--ipv6'), false);
    assert.equal(args[args.length - 1], expectedTarget);
    assert.equal(args[args.indexOf('--proxy') + 1], 'socks5h://127.0.0.1:40080');

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('ip=2606:4700::1\nwarp=on\ncolo=FRA\n'));
      child.emit('close', 0);
    });
    return child;
  };
}

test('IPv6 probe keeps the loopback proxy connection on IPv4', async () => {
  const result = await runCurl('ipv6', 'socks5h://127.0.0.1:40080', {
    spawn: successfulCurl(TARGETS.ipv6),
  });
  assert.equal(result.available, true);
  assert.equal(result.address, '2606:4700::1');
});
