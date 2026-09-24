// Local dev shim: this repo may be opened without `node_modules` installed.
declare module "nats" {
  export type NatsConnection = any;
  export type StringCodec = any;
}
declare module "uuid" {
  export function v4(): string;
}
