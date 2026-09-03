import type { Readable } from "node:stream";

export interface ObjectStore {
  ensurePrivateBucket(): Promise<void>;
  createPresignedZipUpload(input: {
    key: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  getObject(key: string): Promise<Readable>;
  headObject(key: string): Promise<{ size: number } | null>;
  putObject(input: {
    key: string;
    body: Readable;
    size: number;
    contentType: string;
  }): Promise<void>;
  deleteObjects(keys: readonly string[]): Promise<void>;
}

export interface ObjectStoreConfig {
  provider: "minio" | "oss";
  endpoint: string;
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
}
