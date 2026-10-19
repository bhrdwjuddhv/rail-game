# Credits

Rail Bharat's world, trains, textures and sounds are original work generated in code, except the third-party assets listed here.

## 3D models

| Asset | File | Author | Licence | Source | Changes made |
|---|---|---|---|---|---|
| Brake van: "BVZI_ Brake_ Van_indian_train" | `client/public/assets/models/coach/BVZI_Brake_Van.glb` | GameChangz | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) | [skfb.ly/pOQsN](https://skfb.ly/pOQsN) | Fitted by data (`data/coaches/brakevan.json`, `model` section): the brake van of every goods train. Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. The source file itself is unchanged. |
| LHB coach: "Indian Railway LHB Coach" | `client/public/assets/models/coach/lhbfinal.glb` | shubham jha 3d (Sketchfab user shubhamjha201030), published 3 August 2024 | Sketchfab Free Standard (no attribution required; credited anyway) | [sketchfab.com/3d-models/indian-railway-lhb-coach-c6c3d4313425487d91f6174a64dd96d9](https://sketchfab.com/3d-models/indian-railway-lhb-coach-c6c3d4313425487d91f6174a64dd96d9) | Fitted by data (`data/coaches/lhb.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. |
| Double-decker coach: "Indian Railways LHB Double Deker Coach" | `client/public/assets/models/coach/doubledecker.glb` | niladrisekhardam597 (CGTrader), published 7 March 2025 | CGTrader Royalty Free License (no AI: not to be used for training or as input to generative AI) | [cgtrader.com/free-3d-models/vehicle/train/indian-railways-lhb-double-deker-coach](https://www.cgtrader.com/free-3d-models/vehicle/train/indian-railways-lhb-double-deker-coach) | Converted from FBX; fitted by data (`data/coaches/double-decker.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. |
| WDM-3D locomotive | `client/public/assets/models/locos/wdm3d.glb` | Adhyan Saxena (GrabCAD), published 15 June 2023 | GrabCAD Community Library (GrabCAD Terms of Use) | [grabcad.com/library/wdm-3d-locomotive-1](https://grabcad.com/library/wdm-3d-locomotive-1) | Converted from SOLIDWORKS; fitted by data (`data/locomotives/wdm-3d.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. |
| WDP-4B locomotive: "WDG-4 Indian Locomotive" | `client/public/assets/models/locos/wdm4b.glb` | krishna_prasanth, published 8 October 2022 | [CC BY](https://creativecommons.org/licenses/by/4.0/) (Creative Commons Attribution) | [grabcad.com/library/wdg4-2](https://grabcad.com/library/wdg4-2) | A WDG-4 model used for the WDP-4B (same EMD body family). Converted from SOLIDWORKS; fitted by data (`data/locomotives/wdp-4b.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. |
| WAG-9 locomotive: "Indian Railways WAG 9 Electric Locomotive" | `client/public/assets/models/locos/wag9.glb` | niladrisekhardam597 (CGTrader), published 5 March 2025 | CGTrader Royalty Free License (no AI: not to be used for training or as input to generative AI) | [cgtrader.com/free-3d-models/vehicle/train/indian-railways-wag-9-electric-locomotive](https://www.cgtrader.com/free-3d-models/vehicle/train/indian-railways-wag-9-electric-locomotive-1d1e45e5-2a68-4888-bf7a-55381fb71293) | Converted from FBX; fitted by data (`data/locomotives/wag-9.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. |
| Platform drinking water stall: "Railway Startion Water Stall" | `client/public/assets/station/drinkingwater.glb` | the_cgi_guy (Sketchfab user shivamyadavrk), published 14 September 2025 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/railway-startion-water-stall-fece995f24214e058c4ef6fec879274c](https://sketchfab.com/3d-models/railway-startion-water-stall-fece995f24214e058c4ef6fec879274c) | Scaled to size and placed on every platform (`client/src/infrastructure/WaterStall.ts`). Optimised by `npm run models` (`client/tools/props.mjs`): geometry simplified, textures 512 px WebP, Meshopt geometry. The source file itself is unchanged. |
| WAP-7 locomotive | `client/public/assets/models/locos/wap7.glb` | **TO FILL IN: author** | **TO FILL IN: licence (for example CC BY 4.0)** | **TO FILL IN: link to the original** | Fitted by data (`data/locomotives/wap-7.json`, `model` section). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, 3 levels of detail. The operator name and fleet number on the livery texture were repainted to the fictional "Bharat Rail Network" / "भारत रेल नेटवर्क", 30259. The source file itself is unchanged. |
| WAG-12B locomotive ("WAG-12") | `client/public/assets/models/locos/wag-12b.glb` | lakshya11x (Sketchfab user lakshyasharma11052002), published 14 January 2024 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/wag-12-3330081494cd436db99345ea7094caac](https://sketchfab.com/3d-models/wag-12-3330081494cd436db99345ea7094caac) | Fitted by data (`data/locomotives/wag-12b.json`, `model` section): the front half of the model is used for each section of the twin loco (the second section is the first mirrored); its pantograph parts and one stray part are removed and replaced by the game's animated pantographs; two side panels are hidden from the cab view; the window materials are made see-through; a cab interior is added in code (`client/src/train/cab/Wag12Cab.ts`). Optimised by `npm run models`: KTX2 textures, Meshopt geometry, levels of detail. The source file itself is unchanged. |
| Platform crowd: "Indian Woman in Saree" | `client/public/assets/models/people/woman1.glb` | Nodeaxis Interactive (Sketchfab user ar.jethin), published 30 August 2024 | Sketchfab Free Standard (no attribution required; credited anyway. Marked NoAI: not to be used for training or as input to generative AI) | [sketchfab.com/3d-models/indian-woman-in-saree-b5965a93b03440dea65160f7cbac1fc7](https://sketchfab.com/3d-models/indian-woman-in-saree-b5965a93b03440dea65160f7cbac1fc7) | See "People models" below. |
| Platform crowd: "Indian Man" | `client/public/assets/models/people/man2.glb` | Nodeaxis Interactive (ar.jethin), published 4 October 2023 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-man-aa1cb70d9c4f4573a3ff7ae0a5bf82dd](https://sketchfab.com/3d-models/indian-man-aa1cb70d9c4f4573a3ff7ae0a5bf82dd) | See "People models" below. |
| Platform crowd: "Indian Office Woman" | `client/public/assets/models/people/woman2.glb` | Nodeaxis Interactive (ar.jethin), published 5 October 2023 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-office-woman-e6c60cafd33c4d54b0b840c4146ed244](https://sketchfab.com/3d-models/indian-office-woman-e6c60cafd33c4d54b0b840c4146ed244) | See "People models" below. |
| Platform crowd: "Indian Teenager" | `client/public/assets/models/people/teenagerboy.glb` | Nodeaxis Interactive (ar.jethin), published 4 October 2023 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-teenager-b2804b40f671431ca7b5cc53b239175e](https://sketchfab.com/3d-models/indian-teenager-b2804b40f671431ca7b5cc53b239175e) | See "People models" below. |
| Platform crowd: "Indian Man with Red Clothes" | `client/public/assets/models/people/porter.glb` | pankhkhan, published 28 September 2024 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [sketchfab.com/3d-models/indian-man-with-red-clothes-23b1805e473d4e5cb3e439b576ca39a9](https://sketchfab.com/3d-models/indian-man-with-red-clothes-23b1805e473d4e5cb3e439b576ca39a9) | See "People models" below. |

Attribution: "BVZI_ Brake_ Van_indian_train" (https://skfb.ly/pOQsN) by GameChangz is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). Changes were made (see the table).

Attribution: "WDG-4 Indian Locomotive" by krishna_prasanth (https://grabcad.com/library/wdg4-2) is licensed under Creative Commons Attribution (https://creativecommons.org/licenses/by/4.0/). Changes were made (see the table).

Attribution: "Railway Startion Water Stall" (https://sketchfab.com/3d-models/railway-startion-water-stall-fece995f24214e058c4ef6fec879274c) by the_cgi_guy is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). Changes were made (see the table).

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

## Icons

- **Phosphor Icons** (duotone weight) by Helena Zhang and Tobias Fried, MIT licence, https://phosphoricons.com: the general UI icons. Only the icons the game uses are bundled, from `@phosphor-icons/core`; the list is in `client/src/ui/theme/icons.ts`.
- The railway icons (pantograph, breaker, reverser, couplers, signal, loco, coach, wagon and others) are original, drawn in the same duotone style.

## Libraries

The game and its tools use three.js, glTF-Transform, meshoptimizer, sharp, ktx2-encoder (Basis Universal) and Vite, all under the MIT or Apache 2.0 licences. See each package's own licence file in `node_modules`.
