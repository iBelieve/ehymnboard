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

// The eHymnBoard around the Pico W: an emulated RP2040 with the fake CYW43,
// three e-paper panels on SPI0, and flash that survives reboots. A watchdog
// reset rebuilds the RP2040 from the same flash, like a real reboot.
import { ConsoleLogger, GPIOPinState, LogLevel, RP2040, Simulator, USBCDC } from "rp2040js";
import { elfSymbols } from "./elf.ts";
import { EPaperPanel } from "./epaper.ts";
import { type AccessPoint, FakeCYW43 } from "./fake-cyw43.ts";

type SimulationClock = Simulator["clock"]; // not exported by rp2040js

/**
 * rp2040js internals the board reaches into: its types mark these private.
 * nanosCounter sets a fresh clock's time without running alarms, nextAlarm
 * tells "no alarm" from "an alarm due now", and the watchdog's REASON can
 * only be set this way.
 */
interface ClockInternals {
  nanosCounter: number;
  nextAlarm: object | null;
}
interface WatchdogInternals {
  reason: number;
  readonly scratchData: Uint32Array;
  readonly alarm: { enable: boolean };
  onWatchdogTrigger: () => void;
}

const FLASH_BASE = 0x10000000;
const WATCHDOG_BASE = 0x40058;
const GSPI_NANOS_PER_BYTE = 8 * 32; // ~31 MHz bus clock

// Pins from main.cpp for screens 1-3
interface PanelPins {
  id: number;
  power: number;
  cs: number;
  dc: number;
  reset: number;
  busy: number;
}

const PANELS: PanelPins[] = [
  { id: 1, power: 9, cs: 5, dc: 6, reset: 7, busy: 8 },
  { id: 2, power: 14, cs: 10, dc: 11, reset: 12, busy: 13 },
  { id: 3, power: 26, cs: 19, dc: 20, reset: 21, busy: 22 },
];

const hex = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;

// These two look past rp2040js's public types; see the interfaces above.
function clockInternals(clock: SimulationClock): ClockInternals {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- private fields, see ClockInternals
  return clock as unknown as ClockInternals;
}

function watchdogOf(mcu: RP2040): WatchdogInternals {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an RPWatchdog, see WatchdogInternals
  return mcu.peripherals[WATCHDOG_BASE] as unknown as WatchdogInternals;
}

/** Finds a function in the bootrom's lookup table by its two-letter code. */
function romFunction(bootrom: Uint8Array, code: string) {
  const view = new DataView(bootrom.buffer, bootrom.byteOffset, bootrom.byteLength);
  const want = code.charCodeAt(0) | (code.charCodeAt(1) << 8);
  for (let i = view.getUint16(0x14, true); ; i += 4) {
    const entry = view.getUint16(i, true);
    if (entry === 0) {
      throw new Error(`bootrom has no ${code} function`);
    }
    if (entry === want) {
      return view.getUint16(i + 2, true) & ~1;
    }
  }
}

export interface BoardOptions {
  firmware: Uint8Array;
  /**
   * A UF2 flashed before the firmware, for an OTA build: the firmware is then
   * linked after pico_fota_bootloader, which starts at the beginning of flash.
   */
  bootloader?: Uint8Array;
  bootrom: Uint8Array;
  aps: AccessPoint[];
  trace?: boolean;
  /**
   * With the firmware's ELF, calls to cyw43_spi_transfer() are answered
   * directly instead of bit-banging every byte through PIO and DMA, which is
   * many times faster. Without it, the real bus driver runs.
   */
  elf?: Uint8Array;
  log?: (msg: string) => void;
}

/** A bootrom flash erase or program, at an offset in flash. */
export interface FlashOp {
  kind: "erase" | "program";
  offset: number;
  length: number;
}

export interface BoardEvents {
  display: { screen: number; frame: Uint8Array; updateControl: number };
  serial: string;
  reboot: { reason: string };
}

type Listeners = { [K in keyof BoardEvents]: Set<(arg: BoardEvents[K]) => void> };

/** A panel model and the Pico pins it's wired to. */
export type WiredPanel = EPaperPanel & { readonly pins: PanelPins };

export class Board {
  readonly opts: BoardOptions;
  /** The 16 MB QSPI flash: survives reboots. */
  readonly flash = new Uint8Array(16 * 1024 * 1024).fill(0xff);
  readonly romErase: number;
  readonly romProgram: number;
  /** Address of cyw43_spi_transfer(), or 1 (never a PC) for no fast path. */
  readonly spiTransfer: number;
  readonly panels: WiredPanel[];
  private readonly listeners: Listeners = {
    display: new Set(),
    serial: new Set(),
    reboot: new Set(),
  };
  serial = "";
  boots = 0;
  flashWrites = 0;
  /** REASON for the watchdog reset run() should do next, or 0. */
  pendingReboot = 0;
  /** A power cut armed with cutPowerDuring(), or a cut that run() should power back on from. */
  #powerCut?: { left: number; filter: (op: FlashOp) => boolean; done: boolean };
  // Set by powerOn()
  clock!: SimulationClock;
  mcu!: RP2040;
  chip!: FakeCYW43;

  constructor(opts: BoardOptions) {
    this.opts = opts;
    if (opts.bootloader) {
      this.flashUF2(opts.bootloader);
    }
    this.flashUF2(opts.firmware);
    this.romErase = romFunction(opts.bootrom, "RE");
    this.romProgram = romFunction(opts.bootrom, "RP");
    this.spiTransfer = opts.elf ? (elfSymbols(opts.elf).get("cyw43_spi_transfer") ?? 1) & ~1 : 1;
    // The panels outlive a Pico reboot; they lose power when its pins reset.
    this.panels = PANELS.map((pins) => {
      const panel = Object.assign(
        new EPaperPanel({ id: pins.id, after: (ms, fn) => this.after(ms, fn) }),
        { pins },
      );
      panel.onDisplay = ({ image, updateControl }) =>
        this.emit("display", { screen: pins.id, frame: image, updateControl });
      return panel;
    });
    this.powerOn(0);
  }

  /** Writes a UF2's blocks into flash, like dropping it on the BOOTSEL drive. */
  flashUF2(uf2: Uint8Array) {
    for (let off = 0; off + 512 <= uf2.length; off += 512) {
      const view = new DataView(uf2.buffer, uf2.byteOffset + off, 512);
      const addr = view.getUint32(12, true);
      const size = view.getUint32(16, true);
      this.flash.set(uf2.subarray(off + 32, off + 32 + size), addr - FLASH_BASE);
    }
  }

  on<K extends keyof BoardEvents>(event: K, fn: (arg: BoardEvents[K]) => void) {
    this.listeners[event].add(fn);
  }

  emit<K extends keyof BoardEvents>(event: K, arg: BoardEvents[K]) {
    for (const fn of this.listeners[event]) {
      fn(arg);
    }
  }

  after(ms: number, fn: () => void) {
    this.clock.createAlarm(fn).schedule(ms * 1e6);
  }

  get simMs() {
    return this.clock.nanos / 1e6;
  }

  /** (Re)creates the RP2040 and its peripherals, keeping flash and the time. */
  powerOn(watchdogReason: number) {
    this.boots++;
    // mcu, clock and chip are still unset on the first power-on.
    const oldWatchdog = this.mcu ? watchdogOf(this.mcu) : undefined;
    // A fresh clock, so the old chip's timer and watchdog alarms die with it.
    // rp2040js doesn't export SimulationClock, so borrow a Simulator's.
    // Its time is set directly: tick() would run every alarm in between.
    const now = this.clock?.nanos ?? 0;
    this.clock = new Simulator().clock;
    clockInternals(this.clock).nanosCounter = now;
    const mcu = new RP2040(this.clock);
    this.mcu = mcu;
    mcu.loadBootrom(
      new Uint32Array(
        this.opts.bootrom.buffer,
        this.opts.bootrom.byteOffset,
        this.opts.bootrom.byteLength / 4,
      ),
    );
    mcu.flash.set(this.flash);
    mcu.logger = new ConsoleLogger(LogLevel.Error);

    // rp2040js runs PIO on its own timer, far slower than the CPU; run() below
    // steps it in lockstep instead.
    for (const pio of mcu.pio) {
      pio.run = () => {};
    }

    const watchdog = watchdogOf(mcu);
    // A watchdog reset keeps the scratch registers and records why it fired.
    if (watchdogReason) {
      watchdog.reason = watchdogReason;
    }
    if (oldWatchdog && watchdogReason) {
      watchdog.scratchData.set(oldWatchdog.scratchData);
    }
    watchdog.onWatchdogTrigger = () => {
      // rp2040js reschedules the alarm after it fires, and at a count of 0
      // that is 0 ns away, so it would fire forever inside one clock tick.
      // A real reset stops the watchdog, so stop it here too.
      watchdog.alarm.enable = false;
      if (!this.pendingReboot) {
        // rp2040js has just set REASON: TIMER for a timeout, FORCE for a trigger.
        this.pendingReboot = watchdog.reason;
        this.emit("reboot", { reason: "watchdog" });
      }
    };

    const previousChip = this.chip as FakeCYW43 | undefined;
    this.chip = new FakeCYW43(mcu, {
      aps: this.opts.aps,
      trace: this.opts.trace,
      log: this.opts.log,
    });
    if (previousChip) {
      this.chip.onEthernetFromHost = previousChip.onEthernetFromHost;
      this.chip.onLinkChange = previousChip.onLinkChange;
      previousChip.onLinkChange?.(null);
    }

    this.wirePanels(mcu);

    this.attachSerial(mcu);

    mcu.core.PC = FLASH_BASE;
  }

  /**
   * Plugs a USB host's CDC serial driver into the RP2040. USBCDC enumerates
   * the device once, so every time the firmware (re)enables its controller,
   * as the app does after pico_fota_bootloader has used USB, a fresh one
   * enumerates it again, like a host seeing the device come back.
   */
  attachSerial(mcu: RP2040) {
    const cdc = new USBCDC(mcu.usbCtrl);
    // USBCDC answers every OUT (host to device) poll at once with zero bytes,
    // so TinyUSB re-arms the endpoint every 10 us and the CPU never sleeps.
    // Nothing is ever typed at the firmware, so NAK them like a real host.
    mcu.usbCtrl.onEndpointRead = () => {};
    cdc.onSerialData = (bytes) => {
      const text = new TextDecoder().decode(bytes);
      this.serial += text;
      this.emit("serial", text);
    };
    mcu.usbCtrl.onUSBEnabled = () => {
      this.attachSerial(mcu);
      mcu.usbCtrl.resetDevice();
    };
  }

  /**
   * Cuts the power and turns it back on: the firmware starts over from flash,
   * and unlike a watchdog reset nothing survives in the scratch registers.
   */
  powerCycle() {
    this.pendingReboot = 0;
    this.#powerCut = undefined;
    this.powerOn(0);
  }

  /**
   * Cuts the power part way through the `nth` flash operation from now that
   * `filter` picks (only the first sixteenth of an erase's range is erased,
   * or of a program's bytes written: of a boot record's page, half the
   * record), then turns it back on, as powerCycle() does. Returns whether the
   * cut has happened yet.
   */
  cutPowerDuring(nth: number, filter: (op: FlashOp) => boolean = () => true) {
    const cut = { left: nth, filter, done: false };
    this.#powerCut = cut;
    return () => cut.done;
  }

  /** Whether the flash operation about to run is the one to cut short. */
  #cutsShort(op: FlashOp) {
    const cut = this.#powerCut;
    if (!cut || cut.done || !cut.filter(op) || --cut.left > 0) {
      return false;
    }
    cut.done = true;
    return true;
  }

  /** Connects the panels to a new RP2040's pins and SPI0. */
  wirePanels(mcu: RP2040) {
    const high = (pin: number) => mcu.gpio[pin].value === GPIOPinState.High;
    for (const panel of this.panels) {
      const { power, reset, busy } = panel.pins;
      panel.setPower(false);
      panel.setBusy = (value) => mcu.gpio[busy].setInputValue(value);
      mcu.gpio[power].addListener(() => panel.setPower(high(power)));
      mcu.gpio[reset].addListener(() => panel.setReset(high(reset)));
      panel.setReset(high(reset));
    }
    mcu.spi[0].onTransmit = (value) => {
      for (const panel of this.panels) {
        if (mcu.gpio[panel.pins.cs].value === GPIOPinState.Low) {
          panel.byte(value, high(panel.pins.dc));
        }
      }
      mcu.spi[0].completeTransmit(0);
    };
  }

  /**
   * Bootrom flash erase/program: rp2040js has no QSPI flash model, so do them
   * here and return straight to the caller. Returns true when it handled pc.
   */
  romHook(pc: number) {
    const { core } = this.mcu;
    const r = core.registers;
    if (pc !== this.romErase && pc !== this.romProgram) {
      return false;
    }
    const kind = pc === this.romErase ? "erase" : "program";
    const length = kind === "erase" ? r[1] : r[2];
    const short = this.#cutsShort({ kind, offset: r[0], length });
    const done = short ? length >> 4 : length;
    if (kind === "erase") {
      this.flash.fill(0xff, r[0], r[0] + done);
    } else {
      for (let i = 0; i < done; i++) {
        this.flash[r[0] + i] &= this.mcu.readUint8(r[1] + i);
      }
      this.flashWrites++;
    }
    this.mcu.flash.set(
      this.flash.subarray(r[0], r[0] + (pc === this.romErase ? r[1] : r[2])),
      r[0],
    );
    core.PC = core.LR & ~1;
    return true;
  }

  /** The fast path for cyw43_spi_transfer(self, tx, tx_length, rx, rx_length). */
  spiTransferHook() {
    const { mcu } = this;
    const { core } = mcu;
    const r = core.registers;
    const rx = r[3];
    const tx = r[1] || rx;
    const txLength = r[2];
    const rxLength = rx ? mcu.readUint32(core.SP) : 0;
    const bytes = new Uint8Array(txLength);
    for (let i = 0; i < txLength; i++) {
      bytes[i] = mcu.readUint8(tx + i);
    }
    const reply = this.chip.transfer(bytes, rxLength);
    if (rx) {
      for (let i = 0; i < txLength; i++) {
        mcu.writeUint8(rx + i, 0);
      }
      for (let i = 0; i < reply.length; i++) {
        mcu.writeUint8(rx + txLength + i, reply[i]);
      }
    }
    this.clock.tick(Math.max(txLength, rxLength) * GSPI_NANOS_PER_BYTE);
    r[0] = 0;
    core.PC = core.LR & ~1;
  }

  /** Runs the board for up to `ms` of simulated time, or until stop() returns true. */
  run(ms: number, stop: () => boolean = () => false) {
    const end = this.clock.nanos + ms * 1e6;
    while (this.clock.nanos < end) {
      if (this.#powerCut?.done) {
        this.#powerCut = undefined;
        this.pendingReboot = 0;
        this.powerOn(0);
      } else if (this.pendingReboot) {
        const reason = this.pendingReboot;
        this.pendingReboot = 0;
        this.powerOn(reason);
      }
      this.step(20_000, end);
      if (stop()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Runs up to `instructions` instructions, stopping early at a watchdog reset
   * (so the old chip runs no further) or once simulated time reaches `end`.
   */
  step(instructions: number, end = Infinity) {
    const { mcu, clock } = this;
    const { core } = mcu;
    const cycleNanos = 1e9 / (mcu.clocks.sysFreq || 125_000_000);
    const romEnd = 0x4000;
    for (
      let i = 0;
      i < instructions && !this.pendingReboot && !this.#powerCut?.done && clock.nanos < end;
      i++
    ) {
      // PIO only matters while the WiFi chip is selected; skipping it the
      // rest of the time lets sleeps jump straight to the next timer alarm.
      const busActive = this.chip.csActive;
      let cycles;
      if (!core.waiting) {
        if (core.PC < romEnd && this.romHook(core.PC)) {
          continue;
        }
        if (core.PC === this.spiTransfer) {
          this.spiTransferHook();
          continue;
        }
        cycles = core.executeInstruction();
      } else if (busActive) {
        cycles = 8;
      } else {
        // Asleep: jump to the next alarm, but no further than `end`.
        if (!clockInternals(clock).nextAlarm) {
          throw new Error(`CPU asleep at ${hex(core.PC)} with no timer alarm to wake it`);
        }
        clock.tick(Math.min(clock.nanosToNextAlarm, end - clock.nanos));
        continue;
      }
      clock.tick(cycles * cycleNanos);
      if (busActive) {
        for (const pio of mcu.pio) {
          if (!pio.stopped) {
            for (let c = 0; c < cycles; c++) {
              pio.step();
            }
          }
        }
      }
    }
  }
}
