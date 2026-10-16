import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/**
 * The one KTX2 (Basis Universal) loader: textures and the 3D models' embedded textures share it, so the
 * transcoder (basis/*.js + .wasm) is fetched and started once.
 */
let renderer: unknown = null;
let loader: KTX2Loader | null = null;

/** The renderer it transcodes for (set before the first texture loads). */
export function setKtx2Renderer(r: unknown) {
  renderer = r;
  if (loader) loader.detectSupport(r as never);
}

export function ktx2Loader() {
  if (!loader) {
    loader = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).setWorkerLimit(2);
    if (renderer) loader.detectSupport(renderer as never);
  }
  return loader;
}
