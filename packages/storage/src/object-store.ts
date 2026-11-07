import type { Readable } from "node:stream";

export interface ObjectStore {
  ensurePrivateBucket(): Promise<void>;
  createPresignedUpload(input: {
    key: string;
    contentLength: number;
    contentType: string;
    contentMd5: string;
    expiresInSeconds: number;
    internal?: boolean;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  getObject(key: string, options?: HeadObjectOptions): Promise<Readable>;
  headObject(
    key: string,
    options?: HeadObjectOptions,
  ): Promise<{
    size: number;
    contentType: string;
    contentMd5: string;
    crc64?: string;
  } | null>;
  listObjects(input: ListObjectsInput): Promise<ListObjectsResult>;
  deleteObjects(keys: readonly string[]): Promise<void>;
}

export interface HeadObjectOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface ListObjectsInput {
  prefix: string;
  continuationToken?: string;
  maxKeys: number;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface ListObjectsResult {
  keys: string[];
  nextContinuationToken?: string;
}

export interface ObjectStoreConfig {
  provider: "minio" | "oss" | "r2";
  endpoint: string;
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
}
