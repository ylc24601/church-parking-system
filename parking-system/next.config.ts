import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: the real-device LIFF smoke loads the dev server through an HTTPS
  // tunnel; Next 16 blocks cross-origin requests to dev endpoints (e.g. the HMR
  // websocket) unless the tunnel origin is allowlisted.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
