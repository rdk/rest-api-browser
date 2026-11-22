import type { Index, Module, Operation, Summary } from './types';

export function module(id: string, path: string, extra: Partial<Module> = {}): Module {
  return {
    id,
    path,
    origin: 'product',
    stability: 'supported',
    state: 'ok',
    opCount: 0,
    plugin: { key: id.split(':')[0], name: 'Jira' },
    ...extra,
  };
}

export function op(mod: string, method: string, path: string, extra: Partial<Operation> = {}): Operation {
  return {
    key: `${mod}:${method}:${path.replace(/\{[^}]*\}/g, '{}')}`,
    module: mod,
    method,
    path,
    consumes: [],
    produces: ['application/json'],
    params: [],
    ...extra,
  };
}

export function summary(modules: Module[], extra: Partial<Summary> = {}): Summary {
  return {
    format: 1,
    product: { name: 'Jira', version: '11.3.13', build: '1' },
    baseUrl: '/jira',
    hash: 'h1',
    complete: true,
    progress: { done: modules.length, total: modules.length },
    admin: false,
    modules,
    ...extra,
  };
}

export function index(operations: Operation[], hash = 'h1'): Index {
  return { format: 1, hash, operations };
}
