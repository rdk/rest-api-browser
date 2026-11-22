// The app is built for the browser (no @types/node); golden.test.ts runs in node and only needs this one function.
declare module 'node:fs' {
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}
