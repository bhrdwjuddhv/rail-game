import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Serve three.js's Basis Universal transcoder (KTX2 textures) from the game
 * itself at /basis/, version-locked to the installed three.js: dev server
 * middleware + copied into the build. No CDN at runtime.
 */
function basisTranscoder(): Plugin {
  // three does not export its package.json: find the package root from its main entry (build/three.cjs)
  const dir = path.join(path.dirname(createRequire(import.meta.url).resolve('three')), '../examples/jsm/libs/basis');
  const files = ['basis_transcoder.js', 'basis_transcoder.wasm'];
  return {
    name: 'basis-transcoder',
    configureServer(server) {
      server.middlewares.use('/basis', (req, res, next) => {
        const f = files.find(n => req.url?.split('?')[0] === `/${n}`);
        if (!f) return next();
        res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(path.join(dir, f)).pipe(res);
      });
    },
    generateBundle() {
      for (const f of files) this.emitFile({ type: 'asset', fileName: `basis/${f}`, source: fs.readFileSync(path.join(dir, f)) });
    },
  };
}

/**
 * Leave the source PNGs of public/assets/textures out of the build: they are
 * inputs to `npm run textures`; the game only loads the processed KTX2/WebP
 * files in textures/_processed.
 */
function dropTextureSources(): Plugin {
  let outDir = '';
  return {
    name: 'drop-texture-sources',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      // source images and source 3D models: the game only loads the _processed copies
      for (const [dir, ext] of [['assets/textures', /\.(png|jpe?g)$/i], ['assets/models', /\.(glb|gltf|bin)$/i]] as const) {
        const root = path.join(outDir, dir);
        if (!fs.existsSync(root)) continue;
        const walk = (d: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== '_processed') walk(p); }
            else if (ext.test(e.name)) fs.rmSync(p);
          }
          if (d !== root && !fs.readdirSync(d).length) fs.rmdirSync(d);
        };
        walk(root);
      }
    },
  };
}

export default defineConfig({
  plugins: [basisTranscoder(), dropTextureSources()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  // data/ lives at the repo root, shared by client and server
  server: { fs: { allow: ['..'] } },
  test: { name: 'client', environment: 'node', include: ['test/**/*.test.ts'] },
});
