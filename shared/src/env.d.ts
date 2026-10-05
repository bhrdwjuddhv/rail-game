// shared/ compiles with lib ES2022 and no DOM types, so browser-only APIs fail to type-check.
// console is the one host global it uses; both browsers and Node provide it.
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
