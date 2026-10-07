// Keeps the processed textures (KTX2 + WebP from `npm run textures`) in Netlify's build cache between
// deploys. The texture script skips every source whose content hash is unchanged (its .cache.json is
// inside the cached folder), so only new or edited images are re-encoded on a deploy.
const DIRS = ['client/public/assets/textures/_processed', 'client/public/assets/models/_processed'];

export const onPreBuild = async ({ utils }) => {
  for (const dir of DIRS) {
    const ok = await utils.cache.restore(dir);
    console.log(ok ? `texture-cache: restored ${dir}` : `texture-cache: nothing cached yet for ${dir} (first build encodes everything)`);
  }
};

export const onPostBuild = async ({ utils }) => {
  for (const dir of DIRS) {
    const ok = await utils.cache.save(dir);
    console.log(ok ? `texture-cache: saved ${dir}` : `texture-cache: ${dir} not found, nothing saved`);
  }
};
