// Keeps the processed textures (KTX2 + WebP from `npm run textures`) in Netlify's build cache between
// deploys. The texture script skips every source whose content hash is unchanged (its .cache.json is
// inside the cached folder), so only new or edited images are re-encoded on a deploy.
const DIR = 'client/public/assets/textures/_processed';

export const onPreBuild = async ({ utils }) => {
  const ok = await utils.cache.restore(DIR);
  console.log(ok ? `texture-cache: restored ${DIR}` : 'texture-cache: nothing cached yet (first build encodes every texture)');
};

export const onPostBuild = async ({ utils }) => {
  const ok = await utils.cache.save(DIR);
  console.log(ok ? `texture-cache: saved ${DIR}` : `texture-cache: ${DIR} not found, nothing saved`);
};
