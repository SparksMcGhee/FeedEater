// Local dev shim: this repo may be opened without `node_modules` installed.
// Minimal types to keep TS/JSX usable in-editor; real types come from installed deps in Docker builds.

declare module "react" {
  export type ReactNode = any;

  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors React's EffectCallback return union (void | Destructor)
  export function useEffect(effect: (...args: any[]) => void | (() => void), deps?: any[]): void;
  export function useMemo<T>(factory: () => T, deps?: any[]): T;
  export function useRef<T>(initial: T): { current: T };
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  export function useState<T = any>(): [T, (next: T | ((prev: T) => T)) => void];

  export namespace React {
    export type CSSProperties = any;
  }
}

declare module "next/link" {
  const Link: any;
  export default Link;
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
