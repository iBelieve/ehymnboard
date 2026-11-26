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

// A fake Infineon CYW43439 for rp2040js.
//
// It speaks just enough of the gSPI bus protocol, the backplane and the SDPCM
// ioctl/event protocol for the pico-sdk cyw43-driver to bring the chip up,
// scan and (later) join and pass Ethernet frames. The firmware blob the driver
// downloads is accepted and discarded: nothing runs "inside" the chip.
import { GPIOPinState, type RP2040 } from "rp2040js";

const PIN_REG_ON = 23;
const PIN_DATA = 24; // data in/out and host wake share this pin on the Pico W
const PIN_CS = 25;
const PIN_CLK = 29;

// gSPI bus (function 0) registers
const SPI_BUS_CONTROL = 0x00;
const SPI_INTERRUPT_REGISTER = 0x04;
const SPI_STATUS_REGISTER = 0x08;
const SPI_READ_TEST_REGISTER = 0x14;
const TEST_PATTERN = 0xfeedbead;
const WORD_LENGTH_32 = 0x01;
const F2_PACKET_AVAILABLE = 0x20;
const STATUS_F2_RX_READY = 0x20;
const STATUS_F2_PKT_AVAILABLE = 0x100;

// Function 1 (backplane) SDIO core registers
const SDIO_BACKPLANE_ADDRESS_LOW = 0x1000a;
const SDIO_BACKPLANE_ADDRESS_MID = 0x1000b;
const SDIO_BACKPLANE_ADDRESS_HIGH = 0x1000c;
const SDIO_CHIP_CLOCK_CSR = 0x1000e;
const SDIO_SLEEP_CSR = 0x1001f;
const SBSDIO_ALP_AVAIL = 0x40;
const SBSDIO_HT_AVAIL = 0x80;
const SBSDIO_SLPCSR_KEEP_SDIO_ON = 0x01;
const SBSDIO_SLPCSR_DEVICE_ON = 0x02;
const F1_PAD_BYTES = 16; // the driver's CYW43_BACKPLANE_READ_PAD_LEN_BYTES

// Backplane addresses the driver polls
const AI_RESETCTRL = [0x18103800, 0x18104800]; // WLAN ARM and SOCSRAM core wrappers
const RAM_SIZE = 512 * 1024;

// SDPCM
const SDPCM_HEADER_LEN = 12;
const CONTROL_HEADER = 0;
const ASYNCEVENT_HEADER = 1;
const DATA_HEADER = 2;
const WLC_UP = 2;
const WLC_SET_SSID = 26;
const WLC_DISASSOC = 52;
const WLC_GET_VAR = 262;
const WLC_SET_VAR = 263;
const WLC_SET_WSEC_PMK = 268;

const EV_SET_SSID = 0;
const EV_AUTH = 3;
const EV_DEAUTH_IND = 6;
const EV_LINK = 16;
const EV_PSK_SUP = 46;
const EV_ESCAN_RESULT = 69;
const STATUS_SUCCESS = 0;
const STATUS_NO_NETWORKS = 3;
const STATUS_PARTIAL = 8;
const SUP_KEYED = 6;
const SUP_MSG3_TIMEOUT = 8;

// How long the fake radio takes, in simulated milliseconds
const SCAN_MS = 300;
const JOIN_MS = 200;

const swap16x2 = (b: ArrayLike<number>) => [b[1], b[0], b[3], b[2]];

/** An access point in range. No password means an open network. */
export interface AccessPoint {
  ssid: string;
  password?: string;
  bssid?: number[];
  rssi?: number;
  channel?: number;
}

export interface FakeCYW43Options {
  aps?: AccessPoint[];
  log?: (msg: string) => void;
  trace?: boolean;
}

/** A decoded gSPI command word. */
export interface BusCommand {
  write: boolean;
  fn: number;
  addr: number;
  size: number;
}

export class FakeCYW43 {
  readonly mcu: RP2040;
  aps: AccessPoint[];
  /** Called with each Ethernet frame the firmware sends. */
  onEthernetFromHost: ((frame: Uint8Array) => void) | null = null;
  /** Called with the joined AP, or null when the link goes down. */
  onLinkChange: ((ap: AccessPoint | null) => void) | null = null;
  readonly log: (msg: string) => void;
  readonly trace: boolean;
  mac = [0x28, 0xcd, 0xc1, 0x00, 0x00, 0x01];

  // Chip state. The constructor and every WL_ON drop call reset(), which is
  // the one place these are set to their power-on values.
  generation = 0;
  word32!: boolean;
  busRegs!: Uint8Array;
  f1Regs!: Map<number, number>;
  ram!: Uint8Array;
  backplane!: Map<number, number>;
  rxQueue!: Uint8Array[]; // packets for the host
  txSeq!: number;
  hostSeq!: number;
  pmk!: string;
  joined!: AccessPoint | null;
  creditSent!: number;
  up = false;
  stats!: {
    transactions: number;
    clockEdges: number;
    firmwareBytes: number;
    ioctls: number;
    framesIn: number;
    framesOut: number;
  };

  // The bus transaction in progress
  inTransaction!: boolean;
  bitCount = 0;
  curByte = 0;
  rxBytes: number[] = [];
  cmd: BusCommand | null = null;
  out: Uint8Array | null = null;
  outBit = 0;

  constructor(mcu: RP2040, opts: FakeCYW43Options = {}) {
    this.mcu = mcu;
    this.aps = opts.aps ?? [];
    this.log = opts.log ?? ((msg) => console.log(`[cyw43] ${msg}`));
    this.trace = opts.trace ?? false;
    this.reset();

    const gpio = mcu.gpio;
    gpio[PIN_REG_ON].addListener((state) => {
      if (state === GPIOPinState.Low) {
        this.reset();
      }
    });
    gpio[PIN_CS].addListener((state) => {
      if (state === GPIOPinState.Low) {
        this.beginTransaction();
      } else if (state === GPIOPinState.High) {
        this.endTransaction();
      }
    });
    gpio[PIN_CLK].addListener((state, oldState) => {
      if (state === GPIOPinState.High && oldState === GPIOPinState.Low && this.inTransaction) {
        this.clockRisingEdge();
      }
    });
  }

  get csActive() {
    return this.inTransaction;
  }

  reset() {
    // Timers from before a power cycle (a scan or join in progress) must not
    // fire into the new session.
    this.generation++;
    if (this.joined) {
      this.onLinkChange?.(null);
    }
    this.word32 = false;
    this.busRegs = new Uint8Array(0x40);
    this.f1Regs = new Map();
    this.ram = new Uint8Array(RAM_SIZE);
    this.backplane = new Map(AI_RESETCTRL.map((a) => [a, 1]));
    this.rxQueue = [];
    this.txSeq = 0;
    this.hostSeq = 0;
    this.inTransaction = false;
    this.pmk = "";
    this.joined = null;
    this.creditSent = 0;
    this.stats = {
      transactions: 0,
      clockEdges: 0,
      firmwareBytes: 0,
      ioctls: 0,
      framesIn: 0,
      framesOut: 0,
    };
  }

  /** Runs fn after ms of simulated time. */
  after(ms: number, fn: () => void) {
    const generation = this.generation;
    const alarm = this.mcu.clock.createAlarm(() => {
      if (generation === this.generation) {
        fn();
      }
    });
    alarm.schedule(ms * 1e6);
  }

  // ---- gSPI bit level --------------------------------------------------------

  beginTransaction() {
    this.inTransaction = true;
    this.bitCount = 0;
    this.curByte = 0;
    this.rxBytes = [];
    this.cmd = null;
    this.out = null;
    this.outBit = 0;
  }

  endTransaction() {
    if (!this.inTransaction) {
      return;
    }
    this.inTransaction = false;
    this.stats.transactions++;
    if (this.cmd && this.cmd.write) {
      const data = Uint8Array.from(this.rxBytes.slice(4, 4 + this.cmd.size));
      this.handleWrite(this.cmd, data);
    }
    this.updateHostWake();
  }

  clockRisingEdge() {
    this.stats.clockEdges++;
    if (this.out) {
      // Read phase: present the next response bit; the PIO samples it on the
      // following instruction (while the clock is low).
      const byte = this.out[this.outBit >> 3] ?? 0;
      const bit = (byte >> (7 - (this.outBit & 7))) & 1;
      this.mcu.gpio[PIN_DATA].setInputValue(!!bit);
      this.outBit++;
      return;
    }
    const bit = this.mcu.gpio[PIN_DATA].value === GPIOPinState.High ? 1 : 0;
    this.curByte = (this.curByte << 1) | bit;
    this.bitCount++;
    if ((this.bitCount & 7) === 0) {
      this.pushByte(this.curByte);
      this.curByte = 0;
    }
  }

  pushByte(byte: number) {
    this.rxBytes.push(byte);
    if (this.rxBytes.length === 4 && !this.cmd) {
      this.decodeCommand();
    }
  }

  /**
   * A whole gSPI transaction at once, for the emulator's fast path that
   * replaces the firmware's PIO/DMA bus driver: sends tx (command and any
   * write data) and returns the rxLength - tx.length bytes clocked back.
   */
  transfer(tx: Uint8Array, rxLength: number) {
    this.beginTransaction();
    for (const byte of tx) {
      this.pushByte(byte);
    }
    const rx = new Uint8Array(Math.max(0, rxLength - tx.length));
    if (this.out) {
      rx.set(this.out.subarray(0, rx.length));
    }
    this.endTransaction();
    return rx;
  }

  decodeCommand() {
    const b = this.word32 ? this.rxBytes : swap16x2(this.rxBytes);
    const word = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    const cmd = {
      write: !!(word >>> 31),
      fn: (word >>> 28) & 3,
      addr: (word >>> 11) & 0x1ffff,
      size: word & 0x7ff || 0x800,
    };
    this.cmd = cmd;
    if (this.trace) {
      this.log(`${cmd.write ? "W" : "R"} fn${cmd.fn} 0x${cmd.addr.toString(16)} len ${cmd.size}`);
    }
    if (!cmd.write) {
      this.out = this.handleRead(cmd);
      this.outBit = 0;
    }
  }

  // ---- register and memory model ---------------------------------------------

  /** Returns the bytes to clock out, in wire order. */
  handleRead(cmd: BusCommand): Uint8Array {
    switch (cmd.fn) {
      case 0: {
        this.refreshBusRegs();
        const data = this.busRegs.slice(cmd.addr, cmd.addr + Math.max(4, cmd.size));
        return this.word32 ? data : Uint8Array.from(swap16x2(data));
      }
      case 1: {
        const data = new Uint8Array(F1_PAD_BYTES + cmd.size);
        for (let i = 0; i < cmd.size; i++) {
          data[F1_PAD_BYTES + i] = this.readF1Byte(cmd.addr + i);
        }
        return data;
      }
      case 2: {
        const pkt = this.rxQueue.shift() ?? new Uint8Array(4);
        const data = new Uint8Array(Math.max(cmd.size, pkt.length));
        data.set(pkt);
        return data;
      }
      default:
        return new Uint8Array(cmd.size);
    }
  }

  handleWrite(cmd: BusCommand, data: Uint8Array) {
    switch (cmd.fn) {
      case 0: {
        const bytes = this.word32 ? data : Uint8Array.from(swap16x2(data));
        if (cmd.addr === SPI_INTERRUPT_REGISTER) {
          return; // write-1-to-clear; our interrupt bits are derived from state
        }
        if (cmd.addr + cmd.size > this.busRegs.length) {
          this.log(`ignoring bus write to 0x${cmd.addr.toString(16)} len ${cmd.size}`);
          return;
        }
        this.busRegs.set(bytes.subarray(0, cmd.size), cmd.addr);
        if (cmd.addr === SPI_BUS_CONTROL && bytes[0] & WORD_LENGTH_32) {
          this.word32 = true;
        }
        return;
      }
      case 1:
        for (let i = 0; i < cmd.size; i++) {
          this.writeF1Byte(cmd.addr + i, data[i]);
        }
        return;
      case 2:
        this.handleHostPacket(data);
        return;
    }
  }

  refreshBusRegs() {
    const r = new DataView(this.busRegs.buffer);
    const pending = this.rxQueue[0];
    r.setUint16(SPI_INTERRUPT_REGISTER, pending ? F2_PACKET_AVAILABLE : 0, true);
    let status = STATUS_F2_RX_READY;
    if (pending) {
      status |= STATUS_F2_PKT_AVAILABLE | (pending.length << 9);
    }
    r.setUint32(SPI_STATUS_REGISTER, status >>> 0, true);
    r.setUint32(SPI_READ_TEST_REGISTER, TEST_PATTERN, true);
  }

  backplaneAddress(addr: number) {
    const window =
      ((this.f1Regs.get(SDIO_BACKPLANE_ADDRESS_HIGH) ?? 0) << 24) |
      ((this.f1Regs.get(SDIO_BACKPLANE_ADDRESS_MID) ?? 0) << 16) |
      ((this.f1Regs.get(SDIO_BACKPLANE_ADDRESS_LOW) ?? 0) << 8);
    return ((window & ~0x7fff) | (addr & 0x7fff)) >>> 0;
  }

  readF1Byte(addr: number) {
    if (addr >= 0x10000) {
      const value = this.f1Regs.get(addr) ?? 0;
      if (addr === SDIO_CHIP_CLOCK_CSR) {
        return value | SBSDIO_ALP_AVAIL | SBSDIO_HT_AVAIL;
      }
      if (addr === SDIO_SLEEP_CSR) {
        return value & SBSDIO_SLPCSR_KEEP_SDIO_ON ? value | SBSDIO_SLPCSR_DEVICE_ON : value;
      }
      return value;
    }
    const full = this.backplaneAddress(addr);
    return full < RAM_SIZE ? this.ram[full] : (this.backplane.get(full) ?? 0);
  }

  writeF1Byte(addr: number, value: number) {
    if (addr >= 0x10000) {
      this.f1Regs.set(addr, value);
      return;
    }
    const full = this.backplaneAddress(addr);
    if (full < RAM_SIZE) {
      this.ram[full] = value;
      this.stats.firmwareBytes++;
    } else {
      this.backplane.set(full, value);
    }
  }

  // ---- host wake / interrupt line --------------------------------------------

  updateHostWake() {
    if (!this.inTransaction) {
      this.mcu.gpio[PIN_DATA].setInputValue(this.rxQueue.length > 0);
    }
  }

  queueForHost(pkt: Uint8Array) {
    this.rxQueue.push(pkt);
    this.updateHostWake();
  }

  // ---- SDPCM -----------------------------------------------------------------

  sdpcmPacket(channel: number, body: Uint8Array) {
    // Like the real firmware, event and data packets carry 2 bytes of padding
    // after the SDPCM header, so the Ethernet payload lands 2 mod 4 aligned
    // and the IP header that follows it is word aligned.
    const headerLen = SDPCM_HEADER_LEN + (channel === CONTROL_HEADER ? 0 : 2);
    const size = headerLen + body.length;
    const pkt = new Uint8Array(size);
    const v = new DataView(pkt.buffer);
    v.setUint16(0, size, true);
    v.setUint16(2, ~size & 0xffff, true);
    pkt[4] = this.txSeq++ & 0xff;
    pkt[5] = channel;
    pkt[6] = 0; // next length
    pkt[7] = headerLen;
    pkt[8] = 0; // flow control
    // Bus data credit: the host may send packets up to (not including) this
    // sequence number before it has to wait for us.
    this.creditSent = (this.hostSeq + 16) & 0xff;
    pkt[9] = this.creditSent;
    pkt.set(body, headerLen);
    return pkt;
  }

  handleHostPacket(data: Uint8Array) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const size = v.getUint16(0, true);
    if (size === 0 || (size ^ v.getUint16(2, true)) !== 0xffff) {
      this.log(`ignoring malformed host packet (size ${size})`);
      return;
    }
    this.hostSeq = data[4];
    if (((this.creditSent - this.hostSeq) & 0xff) < 4 && this.rxQueue.length === 0) {
      // Running out of credit with nothing to send: send a bare header (a
      // flow control packet) to grant more.
      this.queueForHost(this.sdpcmPacket(CONTROL_HEADER, new Uint8Array(0)));
    }
    const channel = data[5] & 0x0f;
    const headerLen = data[7];
    const payload = data.subarray(headerLen, size);
    if (channel === CONTROL_HEADER) {
      this.handleIoctl(payload);
    } else if (channel === DATA_HEADER) {
      const bdcLen = 4 + (payload[3] << 2);
      this.stats.framesIn++;
      if (this.joined) {
        this.onEthernetFromHost?.(payload.slice(bdcLen));
      }
    } else {
      this.log(`ignoring host packet on channel ${channel}`);
    }
  }

  handleIoctl(payload: Uint8Array) {
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const cmd = v.getUint32(0, true);
    const len = v.getUint32(4, true) & 0xffff;
    const flags = v.getUint32(8, true);
    const data = payload.slice(16, 16 + len);
    const iface = (flags >> 12) & 0xf;
    this.stats.ioctls++;

    let response = data; // SETs echo the request back
    let name = "";
    if (cmd === WLC_GET_VAR || cmd === WLC_SET_VAR) {
      const nul = data.indexOf(0);
      name = new TextDecoder().decode(data.subarray(0, nul < 0 ? data.length : nul));
      const value = data.subarray(nul + 1);
      if (cmd === WLC_GET_VAR) {
        response = this.getVar(name, len);
      } else {
        this.setVar(name, value, iface);
      }
    } else if (cmd === WLC_UP) {
      this.up = true;
    } else if (cmd === WLC_SET_WSEC_PMK) {
      const keyLen = data[0] | (data[1] << 8);
      this.pmk = new TextDecoder().decode(data.subarray(4, 4 + keyLen));
    } else if (cmd === WLC_SET_SSID) {
      const ssidLen = data[0] | (data[1] << 8);
      this.startJoin(new TextDecoder().decode(data.subarray(4, 4 + ssidLen)), iface);
    } else if (cmd === WLC_DISASSOC) {
      this.setLinkDown();
    }
    if (this.trace) {
      this.log(`ioctl ${cmd}${name ? ` "${name}"` : ""} len ${len} itf ${iface}`);
    }

    const body = new Uint8Array(16 + response.length);
    const bv = new DataView(body.buffer);
    bv.setUint32(0, cmd, true);
    bv.setUint32(4, response.length, true);
    bv.setUint32(8, flags, true); // keeps the request id
    bv.setUint32(12, 0, true); // status OK
    body.set(response, 16);
    this.queueForHost(this.sdpcmPacket(CONTROL_HEADER, body));
  }

  getVar(name: string, len: number) {
    const out = new Uint8Array(len);
    switch (name) {
      case "cur_etheraddr":
        out.set(this.mac);
        break;
      case "clmver":
        out.set(new TextEncoder().encode("fake-cyw43 CLM\0").subarray(0, len));
        break;
      default:
        // clmload_status and anything else: zeros (success / off)
        break;
    }
    return out;
  }

  setVar(name: string, value: Uint8Array, iface: number) {
    switch (name) {
      case "cur_etheraddr":
        this.mac = Array.from(value.subarray(0, 6));
        this.log(`MAC set to ${this.mac.map((b) => b.toString(16).padStart(2, "0")).join(":")}`);
        break;
      case "escan":
        this.after(SCAN_MS, () => this.sendScanResults(iface));
        break;
      case "join": {
        const ssidLen = value[0] | (value[1] << 8);
        this.startJoin(new TextDecoder().decode(value.subarray(4, 4 + ssidLen)), iface);
        break;
      }
    }
  }

  // ---- join and link ---------------------------------------------------------

  startJoin(ssid: string, iface: number) {
    this.after(JOIN_MS, () => {
      const ap = this.aps.find((a) => a.ssid === ssid);
      if (!ap) {
        this.log(`join "${ssid}": no such network`);
        this.queueForHost(this.eventPacket(EV_SET_SSID, STATUS_NO_NETWORKS, iface));
        return;
      }
      this.queueForHost(this.eventPacket(EV_AUTH, STATUS_SUCCESS, iface));
      if (ap.password && ap.password !== this.pmk) {
        // A wrong passphrase shows up as the 4-way handshake never finishing,
        // and the AP deauthenticating us.
        this.log(`join "${ssid}": wrong password`);
        this.queueForHost(
          this.eventPacket(EV_PSK_SUP, SUP_MSG3_TIMEOUT, iface, undefined, { reason: 14 }),
        );
        this.queueForHost(
          this.eventPacket(EV_DEAUTH_IND, STATUS_SUCCESS, iface, undefined, { reason: 2 }),
        );
        return;
      }
      this.log(`join "${ssid}": connected`);
      this.joined = ap;
      this.queueForHost(this.eventPacket(EV_LINK, STATUS_SUCCESS, iface, undefined, { flags: 1 }));
      this.queueForHost(this.eventPacket(EV_SET_SSID, STATUS_SUCCESS, iface));
      if (ap.password) {
        this.queueForHost(this.eventPacket(EV_PSK_SUP, SUP_KEYED, iface));
      }
      this.onLinkChange?.(ap);
    });
  }

  /** Drops the connection, as if the AP went away. */
  setLinkDown() {
    if (!this.joined) {
      return;
    }
    this.log(`link to "${this.joined.ssid}" down`);
    this.joined = null;
    this.queueForHost(this.eventPacket(EV_LINK, STATUS_SUCCESS, 0, undefined, { flags: 0 }));
    this.onLinkChange?.(null);
  }

  /** Delivers an Ethernet frame to the firmware. */
  sendEthernet(frame: Uint8Array) {
    if (!this.joined) {
      return;
    }
    const body = new Uint8Array(4 + frame.length);
    body[0] = 0x20; // BDC version 2
    body.set(frame, 4);
    this.stats.framesOut++;
    this.queueForHost(this.sdpcmPacket(DATA_HEADER, body));
  }

  // ---- async events ----------------------------------------------------------

  eventPacket(
    eventType: number,
    status: number,
    iface: number,
    data = new Uint8Array(0),
    { flags = 0, reason = 0 } = {},
  ) {
    // BDC header, then an Ethernet-style header with the Broadcom ethertype,
    // then the BCM event header, then wl_event_msg (big endian), then data.
    const body = new Uint8Array(4 + 24 + 48 + data.length);
    const v = new DataView(body.buffer);
    body[0] = 0x20; // BDC flags (version 2)
    body[2] = iface;
    const eth = 4;
    body.set(this.mac, eth); // dst
    body.set(this.mac, eth + 6); // src
    body[eth + 12] = 0x88;
    body[eth + 13] = 0x6c;
    v.setUint16(eth + 14, 0x8001); // BCM subtype
    v.setUint16(eth + 16, 48 + data.length + 10);
    body[eth + 18] = 0; // version
    body.set([0x00, 0x10, 0x18], eth + 19); // Broadcom OUI
    v.setUint16(eth + 22, 1); // usr subtype: event
    const ev = eth + 24;
    v.setUint16(ev + 0, 2); // version
    v.setUint16(ev + 2, flags);
    v.setUint32(ev + 4, eventType);
    v.setUint32(ev + 8, status);
    v.setUint32(ev + 12, reason);
    v.setUint32(ev + 16, 0); // auth type
    v.setUint32(ev + 20, data.length);
    body[ev + 46] = iface; // ifidx
    body.set(data, ev + 48);
    return this.sdpcmPacket(ASYNCEVENT_HEADER, body);
  }

  escanResult(ap: AccessPoint) {
    // wl_escan_result header followed by one wl_bss_info (little endian).
    const ies = [];
    ies.push(0, ap.ssid.length, ...new TextEncoder().encode(ap.ssid)); // SSID IE
    if (ap.password) {
      // Minimal RSN IE: version 1, CCMP group/pairwise, PSK AKM
      ies.push(
        48,
        20,
        1,
        0,
        0x00,
        0x0f,
        0xac,
        4,
        1,
        0,
        0x00,
        0x0f,
        0xac,
        4,
        1,
        0,
        0x00,
        0x0f,
        0xac,
        2,
        0,
        0,
      );
    }
    const bssLen = 128 + ies.length;
    const buf = new Uint8Array(12 + bssLen);
    const v = new DataView(buf.buffer);
    v.setUint32(0, buf.length, true); // buflen
    v.setUint32(4, 109, true); // version
    v.setUint16(8, 1, true); // sync id
    v.setUint16(10, 1, true); // bss count
    const b = 12;
    v.setUint32(b + 0, 109, true); // bss version
    v.setUint32(b + 4, bssLen, true);
    buf.set(ap.bssid ?? [0x02, 0x00, 0x00, 0x00, 0x00, 0x01], b + 8);
    v.setUint16(b + 14, 100, true); // beacon period
    v.setUint16(b + 16, ap.password ? 0x0011 : 0x0001, true); // ESS (+ privacy)
    const ssid = new TextEncoder().encode(ap.ssid).subarray(0, 32);
    buf[b + 18] = ssid.length;
    buf.set(ssid, b + 19);
    v.setUint16(b + 72, (ap.channel ?? 6) | 0x1000 | 0x2000, true); // chanspec: 2.4 GHz, 20 MHz
    v.setInt16(b + 78, ap.rssi ?? -50, true);
    v.setUint16(b + 116, 128, true); // ie offset
    v.setUint32(b + 120, ies.length, true);
    buf.set(ies, b + 128);
    return buf;
  }

  sendScanResults(iface: number) {
    this.log(`scan: reporting ${this.aps.length} AP(s)`);
    for (const ap of this.aps) {
      this.queueForHost(
        this.eventPacket(EV_ESCAN_RESULT, STATUS_PARTIAL, iface, this.escanResult(ap)),
      );
    }
    this.queueForHost(this.eventPacket(EV_ESCAN_RESULT, STATUS_SUCCESS, iface));
  }
}
