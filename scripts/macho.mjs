import { closeSync, openSync, readSync } from "node:fs";

// Mach-O filetype values, from <mach-o/loader.h>. A relocatable object
// (MH_OBJECT) and a companion debug file (MH_DSYM) are not code objects:
// `codesign` cannot attach a signature to either, so `codesign --sign` leaves
// them alone and `codesign --verify --strict` then reports "code object is not
// signed at all". That is what failed `Release Desktop` #6, on
// cpu-features/build/Release/obj.target/.../filesystem.o — an intermediate that
// scripts/native-build-intermediates.mjs now prunes. Demanding a signature on
// one is a category error that fails a release for a non-reason, on the signed
// path as much as the unsigned one.
export const MH_OBJECT = 1;
export const MH_DSYM = 10;

const UNSIGNABLE_MACH_O_FILETYPES = new Set([MH_OBJECT, MH_DSYM]);

// Keyed by the file's first four bytes, as hex in on-disk order.
const THIN_MACH_O_MAGICS = new Map([
  ["feedface", { littleEndian: false }], // 32-bit, big-endian
  ["cefaedfe", { littleEndian: true }], //  32-bit, little-endian
  ["feedfacf", { littleEndian: false }], // 64-bit, big-endian
  ["cffaedfe", { littleEndian: true }], //  64-bit, little-endian
]);

// `wide` selects fat_arch_64, which widens offset and size to 8 bytes each.
const FAT_MACH_O_MAGICS = new Map([
  ["cafebabe", { wide: false }],
  ["bebafeca", { wide: false }],
  ["cafebabf", { wide: true }],
  ["bfbafeca", { wide: true }],
]);

export const MACH_O_MAGICS = new Set([...THIN_MACH_O_MAGICS.keys(), ...FAT_MACH_O_MAGICS.keys()]);

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}

function thinMachOFiletype(fd, offset) {
  const magicBuffer = readAt(fd, 4, offset);
  if (!magicBuffer) return null;

  const layout = THIN_MACH_O_MAGICS.get(magicBuffer.toString("hex"));
  if (!layout) return null;

  // mach_header: magic, cputype, cpusubtype, filetype — filetype at byte 12.
  const filetypeBuffer = readAt(fd, 4, offset + 12);
  if (!filetypeBuffer) return null;

  return layout.littleEndian ? filetypeBuffer.readUInt32LE(0) : filetypeBuffer.readUInt32BE(0);
}

/**
 * Reads the Mach-O filetype(s) a file declares, following a fat/universal
 * header into each of its slices.
 *
 * @param {string} target Path to inspect.
 * @returns {number[]} Declared filetypes, or `[]` when the file is not Mach-O
 *   or its header cannot be read.
 */
export function machOFiletypes(target) {
  let fd;

  try {
    fd = openSync(target, "r");

    const magicBuffer = readAt(fd, 4, 0);
    if (!magicBuffer) return [];
    const magic = magicBuffer.toString("hex");

    if (THIN_MACH_O_MAGICS.has(magic)) {
      const filetype = thinMachOFiletype(fd, 0);
      return filetype === null ? [] : [filetype];
    }

    const fatLayout = FAT_MACH_O_MAGICS.get(magic);
    if (!fatLayout) return [];

    // fat_header counts are always big-endian on disk, whatever the slices are.
    const countBuffer = readAt(fd, 4, 4);
    if (!countBuffer) return [];
    const sliceCount = countBuffer.readUInt32BE(0);
    // A universal binary has a handful of slices. A larger count means this is
    // not really a fat header (a Java class file opens `cafebabe` too), so
    // report nothing rather than reading megabytes of unrelated offsets.
    if (sliceCount === 0 || sliceCount > 64) return [];

    // fat_arch: cputype, cpusubtype, offset, size, align.
    const entrySize = fatLayout.wide ? 32 : 20;
    const filetypes = [];

    for (let index = 0; index < sliceCount; index += 1) {
      const entryStart = 8 + index * entrySize;
      const offsetBuffer = readAt(fd, fatLayout.wide ? 8 : 4, entryStart + 8);
      if (!offsetBuffer) return [];

      const sliceOffset = fatLayout.wide
        ? Number(offsetBuffer.readBigUInt64BE(0))
        : offsetBuffer.readUInt32BE(0);
      const filetype = thinMachOFiletype(fd, sliceOffset);
      if (filetype !== null) filetypes.push(filetype);
    }

    return filetypes;
  } catch {
    return [];
  } finally {
    if (typeof fd === "number") {
      try {
        closeSync(fd);
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

/**
 * Whether `codesign` can be expected to sign this file.
 *
 * Errs toward `true`: anything whose Mach-O filetype cannot be read keeps the
 * signature requirement, so an unreadable header never silently excuses an
 * unsigned executable.
 *
 * @param {string} target Path to inspect.
 * @returns {boolean}
 */
export function isSignableMachOCode(target) {
  const filetypes = machOFiletypes(target);
  if (filetypes.length === 0) return true;
  return !filetypes.every((filetype) => UNSIGNABLE_MACH_O_FILETYPES.has(filetype));
}
