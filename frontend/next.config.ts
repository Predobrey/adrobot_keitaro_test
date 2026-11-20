import type { NextConfig } from "next";

// Rewrites keep browser requests same-origin and the Keitaro credentials on FastAPI only.
const apiTarget = (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  },
};

export default nextConfig;
