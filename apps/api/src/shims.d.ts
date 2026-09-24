declare var process: any;

declare module "express" {
  export type Request = any;
  export type Response = any;
  export type NextFunction = any;
  const exp: any;
  export default exp;
}

declare module "nats" {
  export type NatsConnection = any;
  export type StringCodec = any;
  export function connect(opts: any): Promise<any>;
  export function StringCodec(): any;
}
