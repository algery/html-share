import Image from "next/image";

export function Brand() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5">
      <Image
        alt=""
        className="brand-mark"
        height={28}
        src="/brand/demo-share-logo.png"
        unoptimized
        width={28}
      />
      <Image
        alt="Demo Share"
        height={40}
        src="/brand/demo-share-wordmark.png"
        unoptimized
        width={120}
      />
    </span>
  );
}
