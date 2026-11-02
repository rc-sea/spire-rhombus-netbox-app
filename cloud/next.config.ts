import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The shared package is consumed from source via tsconfig paths; let Next transpile it.
  transpilePackages: ['@spire/shared'],
  poweredByHeader: false,
};

export default nextConfig;
