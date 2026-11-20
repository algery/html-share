"use client";

import Image from "next/image";
import { useState } from "react";

import type { SquareProject } from "../lib/square-types";
import { ManagementIcon } from "./management-icon";

export function SquareProjectCover({
  apiUrl,
  project,
}: {
  apiUrl: string;
  project: SquareProject;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  const homepage = project.homepage?.url ?? undefined;
  const cover = project.cover;
  const imageUrl = homepage && cover?.status === "ready" ? `${apiUrl}${cover.path}` : undefined;
  const showImage = imageUrl && failedImage !== imageUrl;
  const label = homepage ? "预览暂不可用" : "暂无首页预览";

  return (
    <div className="relative aspect-[8/5] rounded-t-lg bg-slate-100">
      {showImage ? (
        <a
          aria-label={`打开：${project.displayName}`}
          className="block size-full rounded-t-lg focus-visible:outline-2 focus-visible:outline-blue-700"
          href={homepage}
          rel="noopener noreferrer"
          target="_blank"
        >
          <Image
            alt=""
            className="rounded-t-lg object-contain"
            crossOrigin="use-credentials"
            fill
            onError={() => setFailedImage(imageUrl)}
            src={imageUrl}
            unoptimized
          />
        </a>
      ) : (
        <div className="flex size-full items-center justify-center gap-2 px-3 text-sm text-slate-500">
          <ManagementIcon name="code" />
          {label}
        </div>
      )}
    </div>
  );
}
