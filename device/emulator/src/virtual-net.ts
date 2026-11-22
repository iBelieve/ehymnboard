/*
 * eHymnBoard device emulator
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>

 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// A tiny virtual LAN behind the fake access point: one router at 10.0.0.1
// that answers ARP, hands out 10.0.0.2 over DHCP, resolves DNS names and
// serves HTTP on port 80 from a JavaScript handler. Its TCP is just enough for
// lwIP as a client over a lossless link, with a go-back-N resend in case lwIP
// drops a segment for lack of buffers.

const ETH_ARP = 0x0806;
const ETH_IPV4 = 0x0800;
const IP_TCP = 6;
const IP_UDP = 17;

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;
const MSS = 1460;
const RESEND_MS = 250;

const ROUTER_MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0xfe];
const ROUTER_IP = [10, 0, 0, 1];
const CLIENT_IP = [10, 0, 0, 2];
const NETMASK = [255, 255, 255, 0];

type Bytes = Uint8Array;
/** An IPv4 or MAC address as a list of bytes. */
type Address = ArrayLike<number>;

const ipEq = (a: number[], b: Address) => a.every((x, i) => x === b[i]);
const ipStr = (a: ArrayLike<number>) => Array.from(a).join(".");

function checksum(bytes: Bytes, initial = 0) {
  let sum = initial;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    sum += (bytes[i] << 8) | bytes[i + 1];
  }
  if (bytes.length & 1) {
    sum += bytes[bytes.length - 1] << 8;
  }
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return ~sum & 0xffff;
}

function pseudoHeaderSum(src: Address, dst: Address, proto: number, length: number) {
  return (
    ((src[0] << 8) | src[1]) +
    ((src[2] << 8) | src[3]) +
    ((dst[0] << 8) | dst[1]) +
    ((dst[2] << 8) | dst[3]) +
    proto +
    length
  );
}

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  host: string;
  /** The request exactly as the firmware sent it, up to the blank line. */
  raw: string;
}

export interface HttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Accept the request but never answer. */
  stall?: boolean;
  /** Answer with a TCP reset. */
  reset?: boolean;
  /** Close the connection after this many body bytes. */
  truncateAt?: number;
  /**
   * The whole response, status line and headers included, sent byte for byte
   * instead of one built from the fields above.
   */
  raw?: Uint8Array;
}

export interface NetworkOptions {
  after: (ms: number, fn: () => void) => void;
  send: (frame: Uint8Array) => void;
  /** Each name the router resolves maps to true; any other name gets NXDOMAIN. */
  dns: Partial<Record<string, boolean>>;
  /**
   * Answers a request. A promise holds the connection open until it settles,
   * and `pending` counts it meanwhile, so a caller can stop the clock and
   * wait for a real server.
   */
  http: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> | undefined;
  log?: (msg: string) => void;
}

/** One TCP connection from the client to the router's port 80. */
interface Connection {
  key: string;
  ip: number[];
  port: number;
  iss: number;
  sndUna: number;
  sndNxt: number;
  rcvNxt: number;
  peerWnd: number;
  request: string;
  out: Uint8Array | null; // response bytes once known
  finSent: boolean;
  closed: boolean;
  stalled: boolean;
  lastProgress: number;
}

export class VirtualNetwork {
  readonly after: NetworkOptions["after"];
  readonly send: NetworkOptions["send"];
  readonly dns: NetworkOptions["dns"];
  readonly http: NetworkOptions["http"];
  readonly log: (msg: string) => void;
  clientMac: number[] | null = null;
  connections = new Map<string, Connection>();
  ipId = 1;
  /** Every HTTP request served, with the status it got. */
  requests: (HttpRequest & { status: number | undefined })[] = [];
  readonly #pending = new Set<Promise<void>>();

  constructor(opts: NetworkOptions) {
    this.after = opts.after;
    this.send = opts.send;
    this.dns = opts.dns;
    this.http = opts.http;
    this.log = opts.log ?? ((msg) => console.log(`[net] ${msg}`));
  }

  /** How many requests are waiting for an answer from a promise. */
  get pending() {
    return this.#pending.size;
  }

  /** Resolves once every pending request has its answer. */
  async settled() {
    while (this.#pending.size > 0) {
      await Promise.all(this.#pending);
    }
  }

  /** Forgets all TCP connections, as a router reboot or a link drop would. */
  reset() {
    this.connections.clear();
  }

  receive(frame: Bytes) {
    if (frame.length < 14) {
      return;
    }
    this.clientMac = Array.from(frame.subarray(6, 12));
    const type = (frame[12] << 8) | frame[13];
    if (type === ETH_ARP) {
      this.handleArp(frame.subarray(14));
    } else if (type === ETH_IPV4) {
      this.handleIp(frame.subarray(14));
    }
  }

  // ---- link layer ------------------------------------------------------------

  sendEthernet(dstMac: Address, type: number, payload: Bytes) {
    const frame = new Uint8Array(14 + payload.length);
    frame.set(dstMac, 0);
    frame.set(ROUTER_MAC, 6);
    frame[12] = type >> 8;
    frame[13] = type & 0xff;
    frame.set(payload, 14);
    this.send(frame);
  }

  handleArp(arp: Bytes) {
    const op = (arp[6] << 8) | arp[7];
    const targetIp = Array.from(arp.subarray(24, 28));
    // Answer for every address on the LAN except the client's own (lwIP
    // probes that one, and an answer would look like a conflict).
    if (op !== 1 || ipEq(targetIp, CLIENT_IP)) {
      return;
    }
    const reply = new Uint8Array(28);
    reply.set([0, 1, 0x08, 0x00, 6, 4, 0, 2]);
    reply.set(ROUTER_MAC, 8);
    reply.set(targetIp, 14);
    reply.set(arp.subarray(8, 14), 18); // sender MAC
    reply.set(arp.subarray(14, 18), 24); // sender IP
    this.sendEthernet(Array.from(arp.subarray(8, 14)), ETH_ARP, reply);
  }

  // ---- IPv4 ------------------------------------------------------------------

  handleIp(ip: Bytes) {
    const ihl = (ip[0] & 0x0f) * 4;
    const totalLen = (ip[2] << 8) | ip[3];
    const proto = ip[9];
    const src = Array.from(ip.subarray(12, 16));
    const dst = Array.from(ip.subarray(16, 20));
    const payload = ip.subarray(ihl, totalLen);
    if (proto === IP_UDP) {
      this.handleUdp(src, dst, payload);
    } else if (proto === IP_TCP) {
      this.handleTcp(src, dst, payload);
    }
  }

  sendIp(
    src: Address,
    dst: Address,
    proto: number,
    payload: Bytes,
    dstMac: Address | null | undefined = this.clientMac,
  ) {
    if (!dstMac) {
      // Nothing has spoken to the router yet, so there is nowhere to send it.
      this.log(`dropped IP packet to ${ipStr(dst)}: no client MAC yet`);
      return;
    }
    const ip = new Uint8Array(20 + payload.length);
    ip[0] = 0x45;
    ip[2] = ip.length >> 8;
    ip[3] = ip.length & 0xff;
    ip[4] = this.ipId >> 8;
    ip[5] = this.ipId & 0xff;
    this.ipId = (this.ipId + 1) & 0xffff;
    ip[8] = 64; // TTL
    ip[9] = proto;
    ip.set(src, 12);
    ip.set(dst, 16);
    const sum = checksum(ip.subarray(0, 20));
    ip[10] = sum >> 8;
    ip[11] = sum & 0xff;
    ip.set(payload, 20);
    this.sendEthernet(dstMac, ETH_IPV4, ip);
  }

  // ---- UDP: DHCP and DNS -----------------------------------------------------

  handleUdp(src: number[], dst: number[], udp: Bytes) {
    const srcPort = (udp[0] << 8) | udp[1];
    const dstPort = (udp[2] << 8) | udp[3];
    const data = udp.subarray(8, (udp[4] << 8) | udp[5]);
    if (dstPort === 67) {
      this.handleDhcp(data);
    } else if (dstPort === 53 && ipEq(dst, ROUTER_IP)) {
      this.handleDns(src, srcPort, data);
    }
  }

  sendUdp(
    src: Address,
    srcPort: number,
    dst: Address,
    dstPort: number,
    data: Bytes,
    dstMac?: Address,
  ) {
    const udp = new Uint8Array(8 + data.length);
    udp[0] = srcPort >> 8;
    udp[1] = srcPort & 0xff;
    udp[2] = dstPort >> 8;
    udp[3] = dstPort & 0xff;
    udp[4] = udp.length >> 8;
    udp[5] = udp.length & 0xff;
    udp.set(data, 8);
    const sum = checksum(udp, pseudoHeaderSum(src, dst, IP_UDP, udp.length)) || 0xffff;
    udp[6] = sum >> 8;
    udp[7] = sum & 0xff;
    this.sendIp(src, dst, IP_UDP, udp, dstMac ?? this.clientMac);
  }

  handleDhcp(msg: Bytes) {
    if (msg[0] !== 1 || msg.length < 240) {
      return;
    }
    let type = 0;
    for (let i = 240; i < msg.length && msg[i] !== 255;) {
      if (msg[i] === 0) {
        i++;
        continue;
      }
      if (msg[i] === 53) {
        type = msg[i + 2];
      }
      i += 2 + msg[i + 1];
    }
    const DISCOVER = 1;
    const REQUEST = 3;
    const reply = type === DISCOVER ? 2 /* OFFER */ : type === REQUEST ? 5 /* ACK */ : 0;
    if (!reply) {
      return;
    }
    this.log(`DHCP ${reply === 2 ? "offer" : "ack"} ${ipStr(CLIENT_IP)}`);
    const out = new Uint8Array(300);
    out[0] = 2; // BOOTREPLY
    out[1] = 1; // Ethernet
    out[2] = 6;
    out.set(msg.subarray(4, 8), 4); // xid
    out.set(CLIENT_IP, 16); // yiaddr
    out.set(ROUTER_IP, 20); // siaddr
    out.set(msg.subarray(28, 44), 28); // chaddr
    out.set([99, 130, 83, 99], 236); // magic cookie
    const lease = [0, 1, 0x51, 0x80]; // 1 day
    out.set(
      [
        53,
        1,
        reply,
        54,
        4,
        ...ROUTER_IP,
        51,
        4,
        ...lease,
        1,
        4,
        ...NETMASK,
        3,
        4,
        ...ROUTER_IP,
        6,
        4,
        ...ROUTER_IP,
        255,
      ],
      240,
    );
    this.sendUdp(
      ROUTER_IP,
      67,
      [255, 255, 255, 255],
      68,
      out,
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    );
  }

  handleDns(src: number[], srcPort: number, q: Bytes) {
    let i = 12;
    const labels = [];
    while (i < q.length && q[i] !== 0) {
      labels.push(new TextDecoder().decode(q.subarray(i + 1, i + 1 + q[i])));
      i += 1 + q[i];
    }
    const name = labels.join(".").toLowerCase();
    const questionEnd = i + 5;
    const known = this.dns[name] === true;
    this.log(`DNS ${name} -> ${known ? ipStr(ROUTER_IP) : "NXDOMAIN"}`);
    const answer = known ? [0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ROUTER_IP] : [];
    const out = new Uint8Array(questionEnd + answer.length);
    out.set(q.subarray(0, questionEnd));
    out[2] = 0x81; // response, recursion desired
    out[3] = known ? 0x80 : 0x83; // recursion available, NOERROR / NXDOMAIN
    out[6] = 0;
    out[7] = known ? 1 : 0; // answer count
    out.set(answer, questionEnd);
    this.sendUdp(ROUTER_IP, 53, src, srcPort, out);
  }

  // ---- TCP -------------------------------------------------------------------

  handleTcp(src: number[], dst: number[], seg: Bytes) {
    const srcPort = (seg[0] << 8) | seg[1];
    const dstPort = (seg[2] << 8) | seg[3];
    const seq = ((seg[4] << 24) | (seg[5] << 16) | (seg[6] << 8) | seg[7]) >>> 0;
    const ack = ((seg[8] << 24) | (seg[9] << 16) | (seg[10] << 8) | seg[11]) >>> 0;
    const dataOff = (seg[12] >> 4) * 4;
    const flags = seg[13];
    const window = (seg[14] << 8) | seg[15];
    const data = seg.subarray(dataOff);
    const key = `${ipStr(src)}:${srcPort}`;
    let c = this.connections.get(key);

    if (flags & TCP_SYN) {
      if (dstPort !== 80 || !ipEq(dst, ROUTER_IP)) {
        this.sendTcpRaw(src, dstPort, srcPort, 0, (seq + 1) >>> 0, TCP_RST | TCP_ACK, 0);
        return;
      }
      c = {
        key,
        ip: src,
        port: srcPort,
        iss: 1000,
        sndUna: 1001,
        sndNxt: 1001,
        rcvNxt: (seq + 1) >>> 0,
        peerWnd: window,
        request: "",
        out: null, // response bytes once known
        finSent: false,
        closed: false,
        stalled: false,
        lastProgress: 0,
      };
      this.connections.set(key, c);
      this.sendTcpRaw(src, 80, srcPort, c.iss, c.rcvNxt, TCP_SYN | TCP_ACK, MSS);
      return;
    }
    if (!c) {
      if (!(flags & TCP_RST)) {
        this.sendTcpRaw(src, dstPort, srcPort, ack, 0, TCP_RST, 0);
      }
      return;
    }
    if (flags & TCP_RST) {
      this.connections.delete(key);
      return;
    }
    if (flags & TCP_ACK && ((ack - c.sndUna) | 0) > 0) {
      c.sndUna = ack;
      c.lastProgress++;
    }
    c.peerWnd = window;

    if (data.length > 0 || flags & TCP_FIN) {
      if (seq === c.rcvNxt) {
        c.rcvNxt = (c.rcvNxt + data.length + (flags & TCP_FIN ? 1 : 0)) >>> 0;
        c.request += new TextDecoder().decode(data);
      }
      this.sendSegment(c, c.sndNxt, new Uint8Array(0), TCP_ACK);
      if (flags & TCP_FIN && c.finSent) {
        this.connections.delete(key);
        return;
      }
    }
    if (!c.out && c.request.includes("\r\n\r\n")) {
      this.respond(c);
    }
    this.pump(c);
  }

  respond(c: Connection) {
    const head = c.request.slice(0, c.request.indexOf("\r\n\r\n") + 4);
    const [requestLine, ...headerLines] = head.split("\r\n");
    const [method, target = ""] = requestLine.split(" ");
    const [path, qs = ""] = target.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs));
    const hostLine = headerLines.find((h) => h.toLowerCase().startsWith("host:"));
    const req = { method, path, query, host: hostLine ? hostLine.slice(5).trim() : "", raw: head };
    const res = this.http(req) ?? {};
    if (!(res instanceof Promise)) {
      this.answer(c, req, res);
      return;
    }
    // Hold the connection, sending nothing, until the answer comes.
    c.out = new Uint8Array(0);
    c.stalled = true;
    const done = res
      .catch((e: unknown): HttpResponse => {
        this.log(`HTTP ${method} ${target} failed: ${String(e)}`);
        return { reset: true };
      })
      .then((answer) => {
        this.#pending.delete(done);
        if (c.closed || this.connections.get(c.key) !== c) {
          return; // the link or the router went away meanwhile
        }
        c.stalled = false;
        c.out = null;
        this.answer(c, req, answer);
        this.pump(c);
      });
    this.#pending.add(done);
  }

  answer(c: Connection, req: HttpRequest, res: HttpResponse) {
    const code = res.raw ? statusOf(res.raw) : res.status;
    this.requests.push({ ...req, status: code });
    const target = req.raw.split(" ")[1] ?? req.path;
    this.log(
      `HTTP ${req.method} ${target} -> ${res.reset ? "RST" : res.stall ? "no response" : (code ?? 200)}`,
    );

    if (res.reset) {
      this.sendSegment(c, c.sndNxt, new Uint8Array(0), TCP_RST | TCP_ACK);
      this.connections.delete(c.key);
      c.closed = true;
      return;
    }
    if (res.stall) {
      c.out = new Uint8Array(0);
      c.stalled = true;
      return;
    }
    if (res.raw) {
      c.out = res.raw;
      this.scheduleResend(c);
      return;
    }
    const status = res.status ?? 200;
    const body =
      typeof res.body === "string"
        ? new TextEncoder().encode(res.body)
        : (res.body ?? new Uint8Array(0));
    const headers = { "Content-Length": String(body.length), Connection: "close", ...res.headers };
    const head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Status"}\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("")}\r\n`;
    const headBytes = new TextEncoder().encode(head);
    const full = new Uint8Array(headBytes.length + body.length);
    full.set(headBytes);
    full.set(body, headBytes.length);
    c.out =
      res.truncateAt !== undefined ? full.subarray(0, headBytes.length + res.truncateAt) : full;
    this.scheduleResend(c);
  }

  /** Sends as much of the response as the peer's window allows, then FIN. */
  pump(c: Connection) {
    if (!c.out || c.closed || c.stalled) {
      return;
    }
    const base = c.iss + 1;
    const end = base + c.out.length;
    while (((end - c.sndNxt) | 0) > 0) {
      const inFlight = (c.sndNxt - c.sndUna) | 0;
      const room = c.peerWnd - inFlight;
      if (room <= 0) {
        return;
      }
      const offset = (c.sndNxt - base) | 0;
      const len = Math.min(MSS, room, c.out.length - offset);
      this.sendSegment(c, c.sndNxt, c.out.subarray(offset, offset + len), TCP_ACK | TCP_PSH);
      c.sndNxt = (c.sndNxt + len) >>> 0;
    }
    if (!c.finSent) {
      c.finSent = true;
      this.sendSegment(c, c.sndNxt, new Uint8Array(0), TCP_FIN | TCP_ACK);
      c.sndNxt = (c.sndNxt + 1) >>> 0;
    }
  }

  scheduleResend(c: Connection) {
    const progress = c.lastProgress;
    this.after(RESEND_MS, () => {
      if (c.closed || !this.connections.has(c.key) || c.stalled) {
        return;
      }
      if (c.sndUna !== c.sndNxt && c.lastProgress === progress) {
        // Nothing acknowledged since last time: go back and resend.
        c.sndNxt = c.sndUna;
        if (((c.sndNxt - (c.iss + 1 + (c.out?.length ?? 0))) | 0) <= 0) {
          c.finSent = false;
        }
        this.pump(c);
      }
      if (c.sndUna !== c.sndNxt || !c.finSent) {
        this.scheduleResend(c);
      }
    });
  }

  sendSegment(c: Connection, seq: number, data: Bytes, flags: number) {
    this.sendTcpRaw(c.ip, 80, c.port, seq, c.rcvNxt, flags, 0, data);
  }

  sendTcpRaw(
    dst: Address,
    srcPort: number,
    dstPort: number,
    seq: number,
    ack: number,
    flags: number,
    mss: number,
    data: Bytes = new Uint8Array(0),
  ) {
    const optLen = mss ? 4 : 0;
    const seg = new Uint8Array(20 + optLen + data.length);
    const v = new DataView(seg.buffer);
    v.setUint16(0, srcPort);
    v.setUint16(2, dstPort);
    v.setUint32(4, seq >>> 0);
    v.setUint32(8, ack >>> 0);
    seg[12] = ((20 + optLen) / 4) << 4;
    seg[13] = flags;
    v.setUint16(14, 16 * MSS); // our receive window
    if (mss) {
      seg.set([2, 4, mss >> 8, mss & 0xff], 20);
    }
    seg.set(data, 20 + optLen);
    const sum = checksum(seg, pseudoHeaderSum(ROUTER_IP, dst, IP_TCP, seg.length));
    v.setUint16(16, sum);
    this.sendIp(ROUTER_IP, dst, IP_TCP, seg);
  }
}

/** The status code in a raw HTTP response's status line. */
function statusOf(raw: Uint8Array) {
  const line = new TextDecoder().decode(raw.subarray(0, 64)).split("\r\n")[0];
  const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1]);
  return Number.isNaN(code) ? undefined : code;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  204: "No Content",
  304: "Not Modified",
  404: "Not Found",
  500: "Internal Server Error",
  503: "Service Unavailable",
};
