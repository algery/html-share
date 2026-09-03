import { describe, expect, it } from "vitest";

import { UploadTaskStatus } from "./generated/prisma/client.js";
import { cleanupObjectKeysForTask } from "./upload-repository.js";

describe("cleanupObjectKeysForTask", () => {
  it("keeps published revision objects when its temporary ZIP needs a retry", () => {
    expect(
      cleanupObjectKeysForTask({
        stagedObjectKeys: ["projects/demo1/revisions/1/index.html"],
        status: UploadTaskStatus.COMPLETED,
        temporaryObjectKey: "temporary/uploads/upload.zip",
      }),
    ).toEqual(["temporary/uploads/upload.zip"]);
  });

  it("cleans staged revision objects for unsuccessful uploads", () => {
    expect(
      cleanupObjectKeysForTask({
        stagedObjectKeys: ["projects/demo1/revisions/2/index.html"],
        status: UploadTaskStatus.FAILED,
        temporaryObjectKey: "temporary/uploads/upload.zip",
      }),
    ).toEqual(["temporary/uploads/upload.zip", "projects/demo1/revisions/2/index.html"]);
  });
});
