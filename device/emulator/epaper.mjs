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

// A model of the Waveshare 13.3" e-Paper HAT (K): a 960x680 black and white
// panel driven by a Solomon Systech SSD1677 over 4-wire SPI. It follows the
// panel's user manual (Rev 1.0, 2023-07-03: command table in section 6,
// reference sequence in 10.2), checked against Waveshare's own epd13in3k
// drivers (github.com/waveshareteam/e-Paper).
//
// It knows nothing about rp2040js: the board feeds it pin changes and SPI
// bytes, and it drives BUSY through setBusy(). What it shows is the BW RAM as
// addressed through the RAM window and address counters, so a wrong window,
// data entry mode or byte count shows up as a wrong image, not just a wrong
// byte stream. Breaking a rule from the manual (a command while BUSY is high,
// a short parameter list, a write while unpowered) is recorded in `faults`.

export const WIDTH = 960;
export const HEIGHT = 680;
export const ROW_BYTES = WIDTH / 8;
export const RAM_BYTES = ROW_BYTES * HEIGHT; // 81600

// Typical full update time at 23 C, manual section 7.2.
export const REFRESH_MS = 4000;
// Not in the manual: the reference sequence only says to wait for BUSY.
const RESET_BUSY_MS = 1;
const SWRESET_BUSY_MS = 10;
const UPDATE_WITHOUT_DISPLAY_MS = 100;

// RAM content after power-on is undefined; a pattern makes a missed write show.
const POWER_ON_RAM = 0x5a;

// Command code -> [name, data bytes]. RAM writes take any number of bytes.
// 0x37 isn't in the manual's table but Waveshare's partial-update init uses it.
const COMMANDS = new Map([
  [0x01, ['driver output control', 3]],
  [0x03, ['gate driving voltage', 1]],
  [0x04, ['source driving voltage', 3]],
  [0x0c, ['booster soft start', 5]],
  [0x10, ['deep sleep mode', 1]],
  [0x11, ['data entry mode', 1]],
  [0x12, ['software reset', 0]],
  [0x18, ['temperature sensor selection', 1]],
  [0x1a, ['write temperature register', 2]],
  [0x20, ['master activation', 0]],
  [0x21, ['display update control 1', 1]],
  [0x22, ['display update control 2', 1]],
  [0x24, ['write RAM (BW)', Infinity]],
  [0x26, ['write RAM (RED)', Infinity]],
  [0x2c, ['write VCOM register', 1]],
  [0x32, ['write LUT register', 105]],
  [0x37, ['write display option', 10]],
  [0x3c, ['border waveform control', 1]],
  [0x44, ['set RAM X start/end', 4]],
  [0x45, ['set RAM Y start/end', 4]],
  [0x4e, ['set RAM X address counter', 2]],
  [0x4f, ['set RAM Y address counter', 2]],
]);

// Display update control 2 (0x22): bit 2 runs the display pattern.
const UPDATE_DISPLAY = 0x04;

const hex = (n) => `0x${n.toString(16).padStart(2, '0')}`;
const word10 = (lo, hi) => lo | ((hi & 0x03) << 8);

/** The registers a hardware or software reset puts back (POR values from the manual). */
function porRegisters() {
  return {
    gates: 0x2a7 + 1, // driver output control: 680 gate lines
    entryMode: 0x03, // X increment, Y increment, X first
    xStart: 0,
    xEnd: WIDTH - 1,
    yStart: 0,
    yEnd: HEIGHT - 1,
    x: 0,
    y: 0,
    border: 0xc0,
    updateControl: null,
  };
}

export class EPaperPanel {
  /**
   * @param {{ id: number, after: (ms: number, fn: () => void) => void,
   *           refreshMs?: number }} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.after = opts.after;
    this.refreshMs = opts.refreshMs ?? REFRESH_MS;
    /** Set by the board: drives the BUSY pin. */
    this.setBusy = () => {};
    /** Called with { image, updateControl } when a display update finishes. */
    this.onDisplay = () => {};
    /** Test hook: when true, BUSY never drops after it goes high. */
    this.stuckBusy = false;

    this.powered = false;
    this.inReset = false;
    this.busy = false;
    this.generation = 0; // bumped on power-off and reset, so stale timers do nothing
    this.ram = new Uint8Array(RAM_BYTES);
    this.shown = new Uint8Array(RAM_BYTES).fill(0xff); // a blank (white) panel
    this.regs = porRegisters();
    this.deepSleep = false;
    this.current = null; // the command collecting data bytes
    this.lastCommand = null; // the last one finished, to name extra data bytes
    /** Everything the panel received, one line per command or pin event. */
    this.transcript = [];
    /** Rules from the manual the host broke, as readable strings. */
    this.faults = [];
    this.refreshes = 0;
  }

  fault(msg) {
    this.faults.push(msg);
  }

  setPower(on) {
    if (on === this.powered) {
      return;
    }
    this.finishCommand();
    if (!on && this.busy && !this.stuckBusy) {
      this.fault('power cut while BUSY is high');
    }
    this.powered = on;
    this.transcript.push(on ? 'power on' : 'power off');
    this.generation++;
    this.busy = false;
    this.setBusy(false);
    if (on) {
      this.ram.fill(POWER_ON_RAM);
      this.regs = porRegisters();
      this.deepSleep = false;
    }
  }

  /** RES# is active low: high is normal operation. */
  setReset(high) {
    if (!this.powered || high === !this.inReset) {
      this.inReset = !high;
      return;
    }
    this.finishCommand();
    this.inReset = !high;
    if (this.inReset) {
      return;
    }
    this.transcript.push('hardware reset');
    this.generation++;
    this.regs = porRegisters();
    this.deepSleep = false;
    this.busyFor(RESET_BUSY_MS);
  }

  busyFor(ms, then = () => {}) {
    const generation = this.generation;
    this.busy = true;
    this.setBusy(true);
    if (this.stuckBusy) {
      return;
    }
    this.after(ms, () => {
      if (generation === this.generation) {
        this.busy = false;
        this.setBusy(false);
        then();
      }
    });
  }

  /** One byte clocked in while CS# is low; isData is the D/C# pin. */
  byte(value, isData) {
    if (!this.powered) {
      this.fault(`SPI byte ${hex(value)} while the panel is powered off`);
      return;
    }
    if (this.inReset) {
      this.fault(`SPI byte ${hex(value)} while RES# is low`);
      return;
    }
    if (this.busy) {
      // Manual note 5-4: while BUSY is high no command should be sent.
      this.fault(`${isData ? 'data' : 'command'} ${hex(value)} sent while BUSY is high`);
      return;
    }
    if (this.deepSleep) {
      this.fault(`${isData ? 'data' : 'command'} ${hex(value)} sent in deep sleep (needs a hardware reset)`);
      return;
    }
    if (isData) {
      this.data(value);
    } else {
      this.command(value);
    }
  }

  command(code) {
    this.finishCommand();
    this.lastCommand = null;
    const spec = COMMANDS.get(code);
    if (!spec) {
      this.fault(`unknown command ${hex(code)}`);
      return;
    }
    const [name, length] = spec;
    this.current = { code, name, length, data: [], ramBytes: 0 };
    if (length === Infinity) {
      this.ramWriteStart();
    } else if (length === 0) {
      this.finishCommand();
    }
  }

  data(value) {
    const c = this.current;
    if (!c) {
      const last = this.lastCommand;
      this.fault(
        last ? `${hex(last.code)} (${last.name}) got more than its ${last.length} data bytes` : `data ${hex(value)} with no command`,
      );
      return;
    }
    if (c.length === Infinity) {
      this.ramWrite(value);
      return;
    }
    c.data.push(value);
    if (c.data.length === c.length) {
      this.finishCommand();
    }
  }

  /** Applies the command being collected, if any, and logs it. */
  finishCommand() {
    const c = this.current;
    if (!c) {
      return;
    }
    this.current = null;
    this.lastCommand = c;
    if (c.length === Infinity) {
      this.transcript.push(`${hex(c.code)} <${c.ramBytes} bytes>`);
      if (c.ramBytes > this.windowBytes()) {
        this.fault(`${hex(c.code)} wrote ${c.ramBytes} bytes, more than the ${this.windowBytes()} in the RAM window`);
      }
      return;
    }
    this.transcript.push([hex(c.code), ...c.data.map((b) => b.toString(16).padStart(2, '0'))].join(' '));
    if (c.data.length < c.length) {
      this.fault(`${hex(c.code)} (${c.name}) got ${c.data.length} of ${c.length} data bytes`);
      return;
    }
    this.apply(c.code, c.data);
  }

  apply(code, d) {
    const r = this.regs;
    switch (code) {
      case 0x01:
        r.gates = word10(d[0], d[1]) + 1;
        break;
      case 0x10:
        this.deepSleep = (d[0] & 0x03) !== 0;
        break;
      case 0x11:
        r.entryMode = d[0] & 0x07;
        break;
      case 0x12:
        // Software reset: registers to defaults (not deep sleep), RAM affected.
        this.regs = { ...porRegisters() };
        this.busyFor(SWRESET_BUSY_MS);
        break;
      case 0x20:
        this.activate();
        break;
      case 0x22:
        r.updateControl = d[0];
        break;
      case 0x3c:
        r.border = d[0];
        break;
      case 0x44:
        r.xStart = word10(d[0], d[1]);
        r.xEnd = word10(d[2], d[3]);
        break;
      case 0x45:
        r.yStart = word10(d[0], d[1]);
        r.yEnd = word10(d[2], d[3]);
        break;
      case 0x4e:
        r.x = word10(d[0], d[1]);
        break;
      case 0x4f:
        r.y = word10(d[0], d[1]);
        break;
      default:
        // Voltages, LUTs, temperature and soft start don't change the image.
        break;
    }
  }

  windowBytes() {
    const r = this.regs;
    const columns = Math.floor(Math.abs(r.xEnd - r.xStart) / 8) + 1;
    return columns * (Math.abs(r.yEnd - r.yStart) + 1);
  }

  ramWriteStart() {
    const r = this.regs;
    if (r.xStart > r.xEnd || r.yStart > r.yEnd || r.xEnd >= WIDTH || r.yEnd >= HEIGHT) {
      // Decrementing windows are legal but nothing here needs them yet.
      this.fault(`RAM window x ${r.xStart}-${r.xEnd}, y ${r.yStart}-${r.yEnd} isn't modeled`);
    }
  }

  /**
   * Writes one byte (8 pixels, MSB first) at the address counters, then moves
   * them as the data entry mode says, wrapping within the RAM window. X
   * addresses are in pixels (XEA resets to 959), so X moves 8 per byte.
   */
  ramWrite(value) {
    const c = this.current;
    const r = this.regs;
    c.ramBytes++;
    if (c.code !== 0x24) {
      return; // the red RAM isn't shown by a black and white update
    }
    if (r.x < WIDTH && r.y < HEIGHT) {
      this.ram[r.y * ROW_BYTES + (r.x >> 3)] = value;
    }
    const xStep = r.entryMode & 0x01 ? 8 : -8;
    const yStep = r.entryMode & 0x02 ? 1 : -1;
    const stepX = () => {
      r.x += xStep;
      const wrapped = xStep > 0 ? r.x > r.xEnd : r.x < r.xStart;
      if (wrapped) {
        r.x = xStep > 0 ? r.xStart : r.xEnd;
      }
      return wrapped;
    };
    const stepY = () => {
      r.y += yStep;
      const wrapped = yStep > 0 ? r.y > r.yEnd : r.y < r.yStart;
      if (wrapped) {
        r.y = yStep > 0 ? r.yStart : r.yEnd;
      }
      return wrapped;
    };
    if (r.entryMode & 0x04) {
      if (stepY()) {
        stepX();
      }
    } else if (stepX()) {
      stepY();
    }
  }

  /** Master activation (0x20): runs the sequence picked by 0x22. */
  activate() {
    const control = this.regs.updateControl;
    if (control === null) {
      this.fault('master activation (0x20) before display update control 2 (0x22)');
      return;
    }
    if (!(control & UPDATE_DISPLAY)) {
      this.busyFor(UPDATE_WITHOUT_DISPLAY_MS);
      return;
    }
    // Only the first `gates` rows are scanned; the rest keep their old image.
    const image = Uint8Array.from(this.ram);
    const rows = Math.min(this.regs.gates, HEIGHT) * ROW_BYTES;
    this.busyFor(this.refreshMs, () => {
      this.shown.set(image.subarray(0, rows));
      this.refreshes++;
      this.onDisplay({ image: Uint8Array.from(this.shown), updateControl: control });
    });
  }
}
