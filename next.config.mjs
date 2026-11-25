/** @type {import('next').NextConfig} */
const staticAssetHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/_next/static/:path*", headers: staticAssetHeaders },
      { source: "/icon.svg", headers: staticAssetHeaders },
    ];
  },
};

export default nextConfig;
