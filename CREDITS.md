# Credits

Rail Bharat's world, trains, textures and sounds are original work generated in code, except the third-party assets listed here.

## 3D models

| Asset | File | Author | Licence | Source | Changes made |
|---|---|---|---|---|---|
| WAP-7 locomotive | `client/public/assets/models/locos/wap7.glb` | **TO FILL IN: author** | **TO FILL IN: licence (for example CC BY 4.0)** | **TO FILL IN: link to the original** | Fitted by data (`data/locomotives/wap-7.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, 3 levels of detail. The operator name and fleet number on the livery texture were repainted to the fictional "Bharat Rail Network" / "भारत रेल नेटवर्क", 30259. The source file itself is unchanged. |
| WAG-12B locomotive ("WAG-12") | `client/public/assets/models/locos/wag-12b.glb` | lakshya11x (Sketchfab user lakshyasharma11052002), published 14 January 2024 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/wag-12-3330081494cd436db99345ea7094caac](https://sketchfab.com/3d-models/wag-12-3330081494cd436db99345ea7094caac) | Fitted by data (`data/locomotives/wag-12b.json`, `model` section): the front half of the model is used for each section of the twin loco (the second section is the first mirrored); its pantograph parts and one stray part are removed and replaced by the game's animated pantographs; two side panels are hidden from the cab view; the window materials are made see-through; a cab interior is added in code (`client/src/train/cab/Wag12Cab.ts`). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. The source file itself is unchanged. |
| Platform crowd: "Indian Woman in Saree" | `client/public/assets/models/people/woman1.glb` | Nodeaxis Interactive (Sketchfab user ar.jethin), published 30 August 2024 | Sketchfab Free Standard (no attribution required; credited anyway. Marked NoAI: not to be used for training or as input to generative AI) | [sketchfab.com/3d-models/indian-woman-in-saree-b5965a93b03440dea65160f7cbac1fc7](https://sketchfab.com/3d-models/indian-woman-in-saree-b5965a93b03440dea65160f7cbac1fc7) | See "People models" below. |
| Platform crowd: "Indian Man" | `client/public/assets/models/people/man2.glb` | Nodeaxis Interactive (ar.jethin), published 4 October 2023 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-man-aa1cb70d9c4f4573a3ff7ae0a5bf82dd](https://sketchfab.com/3d-models/indian-man-aa1cb70d9c4f4573a3ff7ae0a5bf82dd) | See "People models" below. |
| Platform crowd: "Indian Office Woman" | `client/public/assets/models/people/woman2.glb` | Nodeaxis Interactive (ar.jethin), published 5 October 2023 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-office-woman-e6c60cafd33c4d54b0b840c4146ed244](https://sketchfab.com/3d-models/indian-office-woman-e6c60cafd33c4d54b0b840c4146ed244) | See "People models" below. |
| Platform crowd: "Indian Teenager" | `client/public/assets/models/people/teenagerboy.glb` | Nodeaxis Interactive (ar.jethin), published 4 October 2023 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-teenager-b2804b40f671431ca7b5cc53b239175e](https://sketchfab.com/3d-models/indian-teenager-b2804b40f671431ca7b5cc53b239175e) | See "People models" below. |
| Platform crowd: "Indian Man with Red Clothes" | `client/public/assets/models/people/porter.glb` | pankhkhan, published 28 September 2024 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-man-with-red-clothes-23b1805e473d4e5cb3e439b576ca39a9](https://sketchfab.com/3d-models/indian-man-with-red-clothes-23b1805e473d4e5cb3e439b576ca39a9) | See "People models" below. |

Attribution: "WAG-12" by lakshya11x (https://sketchfab.com/3d-models/wag-12-3330081494cd436db99345ea7094caac) is licensed under Creative Commons Attribution 4.0 (http://creativecommons.org/licenses/by/4.0/). Changes were made (see the table).

"Indian Man", "Indian Office Woman" and "Indian Teenager" by Nodeaxis Interactive, and "Indian Man with Red Clothes" by pankhkhan, are licensed under Creative Commons Attribution 4.0 (http://creativecommons.org/licenses/by/4.0/). Changes were made (see below). "Indian Woman in Saree" by Nodeaxis Interactive is used under the Sketchfab Free Standard licence.

### People models: changes made

`client/tools/people.mjs` (run by `npm run models`) turns each source file into a crowd file (`client/public/assets/models/_processed/people/`). The source files themselves are unchanged. The changes:

- eyelashes, corneas and teeth are removed;
- the parts are merged into one mesh and simplified to about 2,600 and 500 triangles;
- the textures are replaced by colours sampled at each vertex;
- the clothing is recoloured per person in the game;
- each character's own animation is baked into a vertex animation texture;
- an idle or walk clip from another of these characters is added by retargeting;
- a picture of each character is rendered for far distances.

In the game, these credits are shown under **Controls & help → Credits**. Loco models come from each loco's `model` section; the other assets come from `data/credits.json`.

## Libraries

The game and its tools use three.js, glTF-Transform, meshoptimizer, sharp, ktx2-encoder (Basis Universal) and Vite, all under the MIT or Apache 2.0 licences. See each package's own licence file in `node_modules`.
