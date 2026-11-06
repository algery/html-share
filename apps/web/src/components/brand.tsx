import Image from "next/image";

export function Brand() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap text-base font-semibold tracking-tight">
      <Image
        alt=""
        className="brand-mark"
        height={28}
        src="/brand/demo-share-logo.png"
        unoptimized
        width={28}
      />
      demo share
    </span>
  );
}
