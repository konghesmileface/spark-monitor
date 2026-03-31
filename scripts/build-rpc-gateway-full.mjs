#!/usr/bin/env node
/**
 * Build the full RPC gateway into a single deployable JS bundle.
 *
 * Usage: node scripts/build-rpc-gateway-full.mjs
 * Output: scripts/rpc-gateway-full.mjs
 */

import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const result = await esbuild.build({
  entryPoints: ['scripts/rpc-gateway-full-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'scripts/rpc-gateway-full.mjs',
  // Node.js built-in modules must be external
  external: [
    'node:*',
    // undici is CJS and cannot be bundled into ESM.
    // Node.js 18+ ships undici built-in, so import works at runtime.
    'undici',
  ],
  // Allow importing .ts files
  resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  // Handle @/* path aliases
  alias: {
    '@': './src',
  },
  // Inject env vars that are needed at build time (none needed — all runtime)
  define: {
    // Ensure NODE_ENV is not set to production so CORS allows localhost origins
  },
  // Tree-shake unused code
  treeShaking: true,
  // Source map for debugging
  sourcemap: true,
  // Log build info
  logLevel: 'info',
  // Handle CommonJS modules
  mainFields: ['module', 'main'],
  // Metafile for analysis
  metafile: true,
});

// Print bundle size
const output = result.metafile?.outputs?.['scripts/rpc-gateway-full.mjs'];
if (output) {
  const sizeKB = (output.bytes / 1024).toFixed(0);
  console.log(`\n✓ Built rpc-gateway-full.mjs (${sizeKB} KB)`);
  console.log(`  Inputs: ${Object.keys(output.inputs).length} files`);
}
