import * as THREE from 'three/webgpu';
import { tex } from '../../core/Textures';

/**
 * Tutorial highlight: a pulsing glow plus a bobbing arrow that follow an anchor
 * object (a cab control, a gauge, or a signal out in the world). Lives directly
 * in the scene and copies the anchor's render-space position every frame.
 */
export class CabHighlight {
  readonly group = new THREE.Group();
  private glow: THREE.Sprite;
  private arrow: THREE.Mesh;
  private anchor: THREE.Object3D | null = null;
  private size = 0.1;
  private lift = 0;
  private p = new THREE.Vector3();

  constructor() {
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.glow(), color: 0x40c8ff, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true }));
    this.glow.renderOrder = 999;
    const cone = new THREE.ConeGeometry(0.5, 1, 12);
    cone.rotateX(Math.PI); // point down
    cone.translate(0, 0.5, 0);
    this.arrow = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0x40c8ff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.arrow.renderOrder = 999;
    this.group.add(this.glow, this.arrow);
    this.group.visible = false;
  }

  /** size: glow diameter (m); lift: extra height of the arrow above the anchor */
  set(anchor: THREE.Object3D | null, size = 0.12, lift = 0) {
    this.anchor = anchor;
    this.size = size;
    this.lift = lift;
    this.group.visible = !!anchor;
  }

  update(t: number) {
    if (!this.anchor) return;
    this.anchor.getWorldPosition(this.p);
    const pulse = 1 + Math.sin(t * 6) * 0.18;
    this.glow.position.copy(this.p);
    this.glow.scale.setScalar(this.size * 2.2 * pulse);
    this.arrow.position.set(this.p.x, this.p.y + this.size * 0.9 + this.lift + Math.abs(Math.sin(t * 4)) * this.size * 0.4, this.p.z);
    this.arrow.scale.setScalar(this.size * 0.6);
  }
}
