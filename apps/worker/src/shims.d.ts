// Local dev shim: this repo may be opened without `node_modules` installed.
// Minimal types to keep TS strict mode workable in-editor.

declare var process: any;

declare namespace NodeJS {
  type Timeout = {};
}

declare module "nats" {
  export type NatsConnection = any;
  export type StringCodec = any;
  export type ConsumerOptions = any;
  export enum RetentionPolicy {
    Limits,
  }
  export enum StorageType {
    File,
  }
  export function consumerOpts(): ConsumerOptions;
  export function connect(opts: any): Promise<any>;
  export function StringCodec(): any;
}

declare module "pg" {
  export class Pool {
    constructor(opts: any);
    connect(): Promise<any>;
    query(sql: string, params?: any[]): Promise<any>;
  }
}
