export type Origin = 'product' | 'bundled' | 'user';
export type Stability = 'supported' | 'internal' | 'app';
export type ModuleState = 'ok' | 'pending' | 'failed';
export interface Summary {            // GET /rest/restbrowser/1/catalog
  format: 1; product: { name: string; version: string; build: string };
  baseUrl: string;                    // e.g. "http://host/jira", no trailing slash
  hash: string; complete: boolean; progress: { done: number; total: number };
  admin: boolean; modules: Module[];
}
export interface Module {
  id: string;                         // plugin module complete key, unique
  path: string;                       // e.g. "api/2" (requests go to baseUrl + "/rest/" + path + "/" + op.path)
  origin: Origin; stability: Stability; source?: string; state: ModuleState;
  reason?: string; opCount: number; plugin: { key: string; name: string; version?: string }; error?: string;
}
export type ParamIn = 'path' | 'query' | 'header' | 'matrix' | 'form';
export interface Param { name: string; in: ParamIn; type: string; required: boolean; default?: string; options?: string[]; repeating?: boolean; }
export interface Operation {
  key: string;                        // "<moduleId>:<METHOD>:<path with every {template} replaced by {}>" plus optional "#suffix"
  module: string;                     // Module.id
  method: string;                     // GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
  path: string;                       // relative to the module, no leading slash, templates as written: "issue/{issueIdOrKey}"
  consumes: string[]; produces: string[]; params: Param[]; access?: string; deprecated?: boolean;
}
export interface Index { format: 1; hash: string; operations: Operation[]; }   // GET /rest/restbrowser/1/catalog/index/{hash}
