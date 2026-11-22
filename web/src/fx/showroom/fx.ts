import * as THREE from "three";

/** Shared "scan" uniforms: every surface material of the showroom model reads these, so the whole model
 * can be swept by the identification scan or turned into an x-ray at once. */
export interface FxUniforms {
  uScanY: { value: number };
  uScanAmt: { value: number };
  uXray: { value: number };
  uFxColor: { value: THREE.Color };
  uTime: { value: number };
}

export function makeFxUniforms(): FxUniforms {
  return {
    uScanY: { value: -10 },
    uScanAmt: { value: 0 },
    uXray: { value: 0 },
    uFxColor: { value: new THREE.Color(0x46e2ff) },
    uTime: { value: 0 },
  };
}
