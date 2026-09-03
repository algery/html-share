import { readWebEnv } from "@html-share/config";
import type { NextConfig } from "next";

const webEnvironment = readWebEnv(process.env);

const nextConfig: NextConfig = {
  agentRules: false,
  env: {
    NEXT_PUBLIC_API_URL: webEnvironment.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: webEnvironment.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_DEMO_URL: webEnvironment.NEXT_PUBLIC_DEMO_URL,
  },
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@html-share/config"],
};

export default nextConfig;
