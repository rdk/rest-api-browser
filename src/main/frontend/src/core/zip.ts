// Minimal standard PKZIP writer (STORE method 0, IEEE CRC-32, UTF-8 filename flag).
// Produces valid .zip archives with zero external dependencies for downloading decompiled Java sources + metadata.

export interface ZipEntry {
  /** Forward-slash relative path inside the archive (e.g. "sources/com/example/Foo.java"). */
  name: string;
  /** UTF-8 text or raw bytes. */
  data: string | Uint8Array;
  /** Optional modification date (defaults to now). */
  date?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  return {
    time: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

/** Builds a valid binary ZIP archive from the given entries. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const now = new Date();
  const prepared = entries.map((e) => {
    const cleanName = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBytes = enc.encode(cleanName);
    const dataBytes = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const { time, date } = dosTimeDate(e.date ?? now);
    return { nameBytes, dataBytes, crc: crc32(dataBytes), time, date };
  });

  let localTotal = 0;
  let centralTotal = 0;
  for (const p of prepared) {
    localTotal += 30 + p.nameBytes.length + p.dataBytes.length;
    centralTotal += 46 + p.nameBytes.length;
  }
  const out = new Uint8Array(localTotal + centralTotal + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];

  let pos = 0;
  for (const p of prepared) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true); // Local file header signature
    view.setUint16(pos + 4, 20, true); // Version needed (2.0)
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(pos + 8, 0, true); // Compression: STORE
    view.setUint16(pos + 10, p.time, true);
    view.setUint16(pos + 12, p.date, true);
    view.setUint32(pos + 14, p.crc, true);
    view.setUint32(pos + 18, p.dataBytes.length, true);
    view.setUint32(pos + 22, p.dataBytes.length, true);
    view.setUint16(pos + 26, p.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true); // Extra field length
    out.set(p.nameBytes, pos + 30);
    pos += 30 + p.nameBytes.length;
    out.set(p.dataBytes, pos);
    pos += p.dataBytes.length;
  }

  const centralStart = pos;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    view.setUint32(pos, 0x02014b50, true); // Central directory signature
    view.setUint16(pos + 4, 20, true); // Version made by
    view.setUint16(pos + 6, 20, true); // Version needed
    view.setUint16(pos + 8, 0x0800, true); // UTF-8 filename flag
    view.setUint16(pos + 10, 0, true); // Compression: STORE
    view.setUint16(pos + 12, p.time, true);
    view.setUint16(pos + 14, p.date, true);
    view.setUint32(pos + 16, p.crc, true);
    view.setUint32(pos + 20, p.dataBytes.length, true);
    view.setUint32(pos + 24, p.dataBytes.length, true);
    view.setUint16(pos + 28, p.nameBytes.length, true);
    view.setUint16(pos + 30, 0, true); // Extra
    view.setUint16(pos + 32, 0, true); // Comment
    view.setUint16(pos + 34, 0, true); // Disk number
    view.setUint16(pos + 36, 0, true); // Internal attrs
    view.setUint32(pos + 38, 0, true); // External attrs
    view.setUint32(pos + 42, offsets[i], true);
    out.set(p.nameBytes, pos + 46);
    pos += 46 + p.nameBytes.length;
  }

  const centralSize = pos - centralStart;
  view.setUint32(pos, 0x06054b50, true); // End of central directory
  view.setUint16(pos + 4, 0, true);
  view.setUint16(pos + 6, 0, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, centralSize, true);
  view.setUint32(pos + 16, centralStart, true);
  view.setUint16(pos + 20, 0, true);

  return out;
}

/** Converts a Java FQCN into a safe archive path ("sources/com/example/Foo.java"). */
export function javaSourceZipPath(fqcn: string): string {
  const safe = fqcn.replace(/[^A-Za-z0-9_.$]/g, '_').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
  const rel = (safe || 'Unknown').replace(/\./g, '/');
  return `sources/${rel}.java`;
}
