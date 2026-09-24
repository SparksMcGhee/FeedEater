export type ModuleManifest = {
  name: string;
  version: string;
  namespace: string;
  runtime?: {
    entry: string;
  };
  queues?: string[];
  jobs?: Array<{
    name: string;
    queue: string;
    schedule?: string;
    triggeredBy?: string;
    description?: string;
  }>;
};
