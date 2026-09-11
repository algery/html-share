import type { Readable } from "node:stream";

import type { ObjectStore } from "@html-share/storage";

export class Phase4FakeStorage implements ObjectStore {
  signed: {
    contentLength: number;
    contentMd5: string;
    contentType: string;
    expiresInSeconds: number;
    key: string;
  }[] = [];

  async createPresignedUpload(input: (typeof this.signed)[number]) {
    this.signed.push(input);
    return {
      headers: {
        "content-length": String(input.contentLength),
        "content-md5": input.contentMd5,
        "content-type": input.contentType,
      },
      url: `https://storage.test/${input.key}`,
    };
  }
  async deleteObjects() {
    return undefined;
  }
  async ensurePrivateBucket() {
    return undefined;
  }
  async getObject(): Promise<Readable> {
    throw new Error("not used in MCP tests");
  }
  async headObject() {
    return null;
  }
  async listObjects() {
    return { keys: [] };
  }
}
