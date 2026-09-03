declare module "ali-oss" {
  import type { Readable } from "node:stream";

  interface OssResponse {
    headers?: Record<string, string | string[] | undefined>;
  }

  export default class OSS {
    constructor(options: {
      accessKeyId: string;
      accessKeySecret: string;
      authorizationV4: boolean;
      bucket: string;
      endpoint: string;
      region: string;
    });
    signatureUrlV4(
      method: string,
      expires: number,
      request: { headers: Record<string, string> },
      objectName: string,
      additionalHeaders: string[],
    ): Promise<string>;
    getStream(name: string): Promise<{ stream: Readable }>;
    head(name: string): Promise<{ res: OssResponse }>;
    putStream(name: string, body: Readable): Promise<unknown>;
    deleteMulti(names: string[], options: { quiet: boolean }): Promise<unknown>;
  }
}
