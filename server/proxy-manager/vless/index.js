'use strict';

// Native VLESS-over-WebSocket-over-TLS client. No external binaries and no
// extra npm dependencies: the protocol codec, the WebSocket implementation and
// the Cloudflare edge selection are all in this folder.
//
// Scope is deliberately narrow and fails loudly outside it:
//   * transport : VLESS + WebSocket + TLS (CDN-fronted)
//   * not supported: Reality, XTLS Vision, gRPC, XHTTP, mKCP, QUIC, UDP
//   * multiplexing is not implemented; the upstream server must not require it

const { parseUuid, formatUuid } = require('./uuid');
const {
  VERSION,
  COMMAND,
  ADDRESS_TYPE,
  encodeAddress,
  encodeRequestHeader,
  decodeResponseHeader,
  responseHeaderSize
} = require('./vless-header');
const { OPCODE, WebSocketConnection, upgrade, encodeFrame, acceptKeyFor } = require('./websocket');
const { parseVlessLink, isVlessLink } = require('./link');
const {
  CloudflareEdgePool,
  CLOUDFLARE_IPV4_RANGES,
  measureEdge,
  resolveHost,
  sampleFromCidr
} = require('./cf-edges');
const {
  VlessDialer,
  VlessTunnelError,
  TunnelStream,
  createVlessDialer,
  openVlessTunnel
} = require('./dialer');

module.exports = {
  // link parsing
  parseVlessLink,
  isVlessLink,
  // codec
  parseUuid,
  formatUuid,
  VERSION,
  COMMAND,
  ADDRESS_TYPE,
  encodeAddress,
  encodeRequestHeader,
  decodeResponseHeader,
  responseHeaderSize,
  // websocket
  OPCODE,
  WebSocketConnection,
  upgrade,
  encodeFrame,
  acceptKeyFor,
  // cloudflare edges
  CloudflareEdgePool,
  CLOUDFLARE_IPV4_RANGES,
  measureEdge,
  resolveHost,
  sampleFromCidr,
  // dialer
  VlessDialer,
  VlessTunnelError,
  TunnelStream,
  createVlessDialer,
  openVlessTunnel
};
