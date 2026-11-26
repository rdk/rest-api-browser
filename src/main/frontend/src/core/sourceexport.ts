import type { ClassInfo, DecompilerId, OperationSource } from './details';
import { extractClassOutline, formatJavaSource } from '../lib/java-source';
import { buildZip, type ZipEntry } from '../lib/mini-zip';
import type { SourceTab } from './sourcetabs';

/** Converts a Java FQCN into a safe ZIP archive path ("sources/com/example/Foo.java"). */
export function javaSourceZipPath(fqcn: string): string {
  const safe = fqcn.replace(/[^A-Za-z0-9_.$]/g, '_').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
  const rel = (safe || 'Unknown').replace(/\./g, '/');
  return `sources/${rel}.java`;
}

export interface ExportClassMeta {
  class: string;
  file: string;
  decompiler: string;
  decompilerId: DecompilerId;
  totalLines: number;
  bundleId?: number;
  opKey?: string;
  refs: string[];
  outline: {
    kind: string;
    name: string;
    params: string;
    returns: string;
    httpMethod?: string;
    restPath?: string;
    line: number;
  }[];
  info?: ClassInfo;
}

export interface ExportErrorMeta {
  requested: string;
  candidates: string[];
  error: string;
}

export function buildSourceExportItem(
  tab: SourceTab,
  src: OperationSource,
  options: { pretty: boolean; decompiler: DecompilerId; classInfo?: ClassInfo; seenPaths: Set<string> },
): { entry: ZipEntry; meta: ExportClassMeta } {
  const base = javaSourceZipPath(src.class);
  let file = base;
  let n = 2;
  while (options.seenPaths.has(file)) {
    file = base.replace(/\.java$/, `_${n++}.java`);
  }
  options.seenPaths.add(file);

  const text = options.pretty ? formatJavaSource(src.source) : src.source;
  const lines = text.split('\n');
  const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length;
  // Compute outline from the exact exported text so metadata.json line numbers match the .java file.
  const outline = extractClassOutline(lines);
  return {
    entry: { name: file, data: text.endsWith('\n') ? text : text + '\n' },
    meta: {
      class: src.class,
      file,
      decompiler: src.decompiler,
      decompilerId: src.decompilerId ?? options.decompiler,
      totalLines: options.pretty ? lineCount : (src.totalLines ?? lineCount),
      bundleId: src.bundleId,
      opKey: tab.opKey,
      refs: src.refs ?? [],
      outline: outline.map((o) => ({
        kind: o.kind,
        name: o.name,
        params: o.params,
        returns: o.returns,
        ...(o.httpMethod ? { httpMethod: o.httpMethod } : {}),
        ...(o.restPath !== undefined ? { restPath: o.restPath } : {}),
        line: o.line + 1,
      })),
      info: options.classInfo,
    },
  };
}

export function buildSourceArchive(
  entries: ZipEntry[],
  metaClasses: (ExportClassMeta | ExportErrorMeta)[],
  options: { decompiler: DecompilerId; tabCount: number; exportedAt?: string },
): { bytes: Uint8Array; filename: string } {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const metadata = {
    format: 1,
    exportedAt,
    decompiler: options.decompiler,
    tabCount: options.tabCount,
    classes: metaClasses,
  };
  const allEntries: ZipEntry[] = [...entries, { name: 'metadata.json', data: JSON.stringify(metadata, null, 2) + '\n' }];
  const bytes = buildZip(allEntries);
  const stamp = exportedAt.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return { bytes, filename: `decompiled-classes-${stamp}.zip` };
}
