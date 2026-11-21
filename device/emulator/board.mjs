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
import { ConsoleLogger, GPIOPinState, LogLevel, RP2040, Simulator, USBCDC } from 'rp2040js';
import { elfSymbols } from './elf.mjs';
import { EPaperPanel } from './epaper.mjs';
import { FakeCYW43 } from './fake-cyw43.mjs';

const FLASH_BASE = 0x10000000;
const WATCHDOG_BASE = 0x40058;
const WATCHDOG_REASON_TIMER = 1;
const GSPI_NANOS_PER_BYTE = 8 * 32; // ~31 MHz bus clock

// Pins from main.cpp for screens 1-3
const PANELS = [
  { id: 1, power: 9, cs: 5, dc: 6, reset: 7, busy: 8 },
  { id: 2, power: 14, cs: 10, dc: 11, reset: 12, busy: 13 },
  { id: 3, power: 26, cs: 19, dc: 20, reset: 21, busy: 22 },
];

/** Finds a function in the bootrom's lookup table by its two-letter code. */
function romFunction(bootrom, code) {
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

export class Board {
  /**
   * @param {{ firmware: Uint8Array, bootrom: Uint8Array, aps: object[], trace?: boolean,
   *           elf?: Uint8Array, log?: (msg: string) => void }} opts
   *   With the firmware's ELF, calls to cyw43_spi_transfer() are answered
   *   directly instead of bit-banging every byte through PIO and DMA, which
   *   is many times faster. Without it, the real bus driver runs.
   */
  constructor(opts) {
    this.opts = opts;
    this.flash = new Uint8Array(16 * 1024 * 1024).fill(0xff);
    for (let off = 0; off + 512 <= opts.firmware.length; off += 512) {
      const view = new DataView(opts.firmware.buffer, opts.firmware.byteOffset + off, 512);
      const addr = view.getUint32(12, true);
      const size = view.getUint32(16, true);
      this.flash.set(opts.firmware.subarray(off + 32, off + 32 + size), addr - FLASH_BASE);
    }
    this.romErase = romFunction(opts.bootrom, 'RE');
    this.romProgram = romFunction(opts.bootrom, 'RP');
    this.spiTransfer = opts.elf ? (elfSymbols(opts.elf).get('cyw43_spi_transfer') ?? 1) & ~1 : 1;
    this.listeners = new Map();
    this.serial = '';
    this.boots = 0;
    this.flashWrites = 0;
    // The panels outlive a Pico reboot; they lose power when its pins reset.
    this.panels = PANELS.map((pins) => {
      const panel = new EPaperPanel({ id: pins.id, after: (ms, fn) => this.after(ms, fn) });
      panel.pins = pins;
      panel.onDisplay = ({ image, updateControl }) =>
        this.emit('display', { screen: pins.id, frame: image, updateControl });
      return panel;
    });
    this.powerOn(0);
  }

  on(event, fn) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(fn);
  }

  emit(event, arg) {
    for (const fn of this.listeners.get(event) ?? []) {
      fn(arg);
    }
  }

  after(ms, fn) {
    this.clock.createAlarm(fn).schedule(ms * 1e6);
  }

  get simMs() {
    return this.clock.nanos / 1e6;
  }

  /** (Re)creates the RP2040 and its peripherals, keeping flash and the time. */
  powerOn(watchdogReason) {
    this.boots++;
    // A fresh clock, so the old chip's timer and watchdog alarms die with it.
    // rp2040js doesn't export SimulationClock, so borrow a Simulator's.
    // Its time is set directly: tick() would run every alarm in between.
    const now = this.clock?.nanos ?? 0;
    this.clock = new Simulator().clock;
    this.clock.nanosCounter = now;
    const mcu = new RP2040(this.clock);
    this.mcu = mcu;
    mcu.loadBootrom(
      new Uint32Array(this.opts.bootrom.buffer, this.opts.bootrom.byteOffset, this.opts.bootrom.byteLength / 4),
    );
    mcu.flash.set(this.flash);
    mcu.logger = new ConsoleLogger(LogLevel.Error);

    // rp2040js runs PIO on its own timer, far slower than the CPU; run() below
    // steps it in lockstep instead.
    for (const pio of mcu.pio) {
      pio.run = () => {};
    }

    const watchdog = mcu.peripherals[WATCHDOG_BASE];
    if (watchdogReason) {
      watchdog.reason = watchdogReason;
    }
    watchdog.onWatchdogTrigger = () => {
      // rp2040js reschedules the alarm after it fires, and at a count of 0
      // that is 0 ns away, so it would fire forever inside one clock tick.
      // A real reset stops the watchdog, so stop it here too.
      watchdog.alarm.enable = false;
      if (!this.pendingReboot) {
        this.pendingReboot = true;
        this.emit('reboot', { reason: 'watchdog' });
      }
    };

    const previousChip = this.chip;
    this.chip = new FakeCYW43(mcu, { aps: this.opts.aps, trace: this.opts.trace, log: this.opts.log });
    if (previousChip) {
      this.chip.onEthernetFromHost = previousChip.onEthernetFromHost;
      this.chip.onLinkChange = previousChip.onLinkChange;
      previousChip.onLinkChange?.(null);
    }

    this.wirePanels(mcu);

    const cdc = new USBCDC(mcu.usbCtrl);
    // USBCDC answers every OUT (host to device) poll at once with zero bytes,
    // so TinyUSB re-arms the endpoint every 10 us and the CPU never sleeps.
    // Nothing is ever typed at the firmware, so NAK them like a real host.
    mcu.usbCtrl.onEndpointRead = () => {};
    cdc.onSerialData = (bytes) => {
      const text = new TextDecoder().decode(bytes);
      this.serial += text;
      this.emit('serial', text);
    };

    mcu.core.PC = FLASH_BASE;
  }

  /** Connects the panels to a new RP2040's pins and SPI0. */
  wirePanels(mcu) {
    const high = (pin) => mcu.gpio[pin].value === GPIOPinState.High;
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
  romHook(pc) {
    const { core } = this.mcu;
    const r = core.registers;
    if (pc === this.romErase) {
      this.flash.fill(0xff, r[0], r[0] + r[1]);
    } else if (pc === this.romProgram) {
      for (let i = 0; i < r[2]; i++) {
        this.flash[r[0] + i] &= this.mcu.readUint8(r[1] + i);
      }
      this.flashWrites++;
    } else {
      return false;
    }
    this.mcu.flash.set(this.flash.subarray(r[0], r[0] + (pc === this.romErase ? r[1] : r[2])), r[0]);
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
  run(ms, stop = () => false) {
    const end = this.clock.nanos + ms * 1e6;
    while (this.clock.nanos < end) {
      if (this.pendingReboot) {
        this.pendingReboot = false;
        this.powerOn(WATCHDOG_REASON_TIMER);
      }
      this.step(20_000);
      if (stop()) {
        return true;
      }
    }
    return false;
  }

  step(instructions) {
    const { mcu, clock } = this;
    const { core } = mcu;
    const cycleNanos = 1e9 / (mcu.clocks.sysFreq || 125_000_000);
    const romEnd = 0x4000;
    for (let i = 0; i < instructions; i++) {
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
        clock.tick(clock.nanosToNextAlarm);
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
