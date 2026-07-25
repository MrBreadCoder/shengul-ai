import type { NextConfig } from "next";

interface RemotePattern {
  protocol: "http" | "https";
  hostname: string;
  pathname: string;
}

// Uploaded client logos are served from this project's own Supabase Storage
// public URL — derived from the same env var the app already requires, so no
// separate config value is needed. Parsed defensively: next.config.ts loads
// before src/lib/env's Zod validation ever runs, so a missing/malformed URL
// here must not crash the build — it just means logo images render
// unoptimized (next/image falls back gracefully) until the env var is set.
function supabaseStorageRemotePattern(): RemotePattern[] {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return [];
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    return [
      {
        protocol: url.protocol === "http:" ? "http" : "https",
        hostname: url.hostname,
        pathname: "/storage/v1/object/public/client-logos/**",
      },
    ];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Single stable host regardless of which company domain is requested —
      // the target domain is a query param, not the image's own host, so this
      // one pattern covers every case's favicon without whitelisting arbitrary
      // third-party domains.
      {
        protocol: "https",
        hostname: "www.google.com",
        pathname: "/s2/favicons/**",
      },
      ...supabaseStorageRemotePattern(),
    ],
  },
};

export default nextConfig;
