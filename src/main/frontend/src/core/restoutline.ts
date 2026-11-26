import { normalizeRestPath, type OutlineItem } from '../lib/java-source';
import type { Module, Operation } from './types';

export interface MatchedEndpoint {
  op: Operation;
  /** Full display path including module base (e.g. "/rest/api/2/serverInfo"). */
  fullPath: string;
}

/**
 * Matches REST-annotated methods in a decompiled class's outline to concrete catalog operations in $O(M + N)$
 * by indexing operations by `(HTTP_METHOD, normalizedPath)` upfront.
 */
export function matchOutlineEndpoints(
  outline: OutlineItem[],
  operations: Operation[],
  modulesById: Map<string, Module>,
  contextOpKey?: string,
  focusMethod?: string,
): Map<number, MatchedEndpoint> {
  const result = new Map<number, MatchedEndpoint>();
  if (!outline.length || !operations.length) return result;

  const restItems = outline.filter((o) => o.kind === 'method' && o.httpMethod);
  if (!restItems.length) return result;

  let contextOp: Operation | undefined;
  const byMethod = new Map<string, { op: Operation; norm: string }[]>();
  const byMethodExact = new Map<string, Map<string, Operation[]>>();

  for (const op of operations) {
    if (contextOpKey && op.key === contextOpKey) contextOp = op;
    const m = op.method.toUpperCase();
    const norm = normalizeRestPath(op.path);
    let list = byMethod.get(m);
    if (!list) {
      list = [];
      byMethod.set(m, list);
    }
    list.push({ op, norm });

    let exactMap = byMethodExact.get(m);
    if (!exactMap) {
      exactMap = new Map();
      byMethodExact.set(m, exactMap);
    }
    let exactList = exactMap.get(norm);
    if (!exactList) {
      exactList = [];
      exactMap.set(norm, exactList);
    }
    exactList.push(op);
  }

  const contextModuleId = contextOp?.module;
  const contextPluginKey = contextModuleId ? modulesById.get(contextModuleId)?.plugin.key : undefined;

  const pickBest = (candidates: Operation[]): Operation | undefined => {
    if (!candidates.length) return undefined;
    if (candidates.length === 1) return candidates[0];
    if (contextOpKey) {
      const exact = candidates.find((o) => o.key === contextOpKey);
      if (exact) return exact;
    }
    if (contextModuleId) {
      const sameMod = candidates.filter((o) => o.module === contextModuleId);
      if (sameMod.length) candidates = sameMod;
    }
    if (contextPluginKey && candidates.length > 1) {
      const samePlugin = candidates.filter((o) => modulesById.get(o.module)?.plugin.key === contextPluginKey);
      if (samePlugin.length) candidates = samePlugin;
    }
    if (candidates.length > 1) {
      const active = candidates.filter((o) => !o.deprecated);
      if (active.length) candidates = active;
    }
    return candidates[0];
  };

  const toMatched = (op: Operation): MatchedEndpoint => {
    const mod = modulesById.get(op.module);
    const modPath = mod ? mod.path.replace(/^\/+|\/+$/g, '') : '';
    const opPath = op.path.replace(/^\/+/, '');
    const fullPath = modPath ? `/rest/${modPath}${opPath ? '/' + opPath : ''}` : (opPath ? `/rest/${opPath}` : '/rest');
    return { op, fullPath };
  };

  for (const item of restItems) {
    const method = item.httpMethod!;
    let matched: Operation | undefined;

    if (item.fullRestPath !== undefined) {
      const targetNorm = normalizeRestPath(item.fullRestPath);
      const exact = byMethodExact.get(method)?.get(targetNorm);
      if (exact) matched = pickBest(exact);
      if (!matched && targetNorm) {
        const pool = byMethod.get(method) ?? [];
        const suffix = pool.filter((e) => e.norm.endsWith('/' + targetNorm)).map((e) => e.op);
        if (suffix.length === 1) {
          matched = suffix[0];
        } else if (suffix.length > 1 && (contextModuleId || contextOpKey)) {
          matched = pickBest(suffix);
        }
      }
    }

    if (!matched && contextOp && focusMethod && item.name === focusMethod && contextOp.method.toUpperCase() === method) {
      matched = contextOp;
    }

    if (matched) {
      result.set(item.line, toMatched(matched));
    }
  }
  return result;
}

/** Maps catalog shorthand parameter types ("string", "int", "File") to a Java class FQCN when no `javaType` is given. */
export function fallbackJavaType(paramType: string): string | undefined {
  switch (paramType.toLowerCase()) {
    case 'string': return 'java.lang.String';
    case 'int':
    case 'integer': return 'java.lang.Integer';
    case 'long': return 'java.lang.Long';
    case 'boolean': return 'java.lang.Boolean';
    case 'number':
    case 'double': return 'java.lang.Double';
    case 'float': return 'java.lang.Float';
    case 'file': return 'com.atlassian.plugins.rest.api.multipart.FilePart';
    default: return /^[A-Z]/.test(paramType) ? paramType : undefined;
  }
}
