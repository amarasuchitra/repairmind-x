import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { RoundedBox } from "@react-three/drei";
import type { Tri } from "../sim/shell.ts";
import type { Piece } from "./explode.ts";

/**
 * Lifelike stand-ins for the real parts, at their real size in millimetres: the board colours, chips, header pins,
 * connectors and LEDs you see when you open the bag. Each lies flat with its thickness along z (up in the view).
 *
 * "holo" draws the same shapes as a glowing hologram instead.
 */

export type Look = "real" | "holo";

const HOLO = "#46e2ff";
const GOLD = { color: "#d8b24a", metalness: 1, roughness: 0.25 } as const;
const STEEL = { color: "#c9d1db", metalness: 1, roughness: 0.22 } as const;
const BLACK_PLASTIC = { color: "#15171b", metalness: 0, roughness: 0.55 } as const;

function Mat({ look, color, metalness = 0, roughness = 0.5, glow, opacity = 1 }: {
  look: Look; color: string; metalness?: number; roughness?: number; glow?: string; opacity?: number;
}) {
  if (look === "holo") {
    return <meshBasicMaterial color={glow ?? HOLO} transparent opacity={glow ? 0.95 : 0.28} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />;
  }
  if (glow) return <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={2.2} toneMapped={false} />;
  return <meshPhysicalMaterial color={color} metalness={metalness} roughness={roughness} clearcoat={metalness ? 0 : 0.25} clearcoatRoughness={0.4} transparent={opacity < 1} opacity={opacity} />;
}

/** A header pin strip along one edge, under the board: a black plastic bar with gold pins pointing down. */
function Header({ look, n, x, y, along = "x", pitch = 2.54, z }: { look: Look; n: number; x: number; y: number; along?: "x" | "y"; pitch?: number; z: number }) {
  const len = n * pitch;
  return (
    <group position={[x, y, z]}>
      <mesh rotation={[0, 0, along === "y" ? Math.PI / 2 : 0]} position={[0, 0, -1.25]}>
        <boxGeometry args={[len, 2.5, 2.5]} /><Mat look={look} {...BLACK_PLASTIC} />
      </mesh>
      {Array.from({ length: n }, (_, i) => {
        const o = -len / 2 + pitch / 2 + i * pitch;
        return (
          <mesh key={i} position={along === "x" ? [o, 0, -4.2] : [0, o, -4.2]}>
            <boxGeometry args={[0.64, 0.64, 6]} /><Mat look={look} {...GOLD} />
          </mesh>
        );
      })}
    </group>
  );
}

function Pcb({ look, w, h, color, t = 1.6, children }: { look: Look; w: number; h: number; color: string; t?: number; children?: React.ReactNode }) {
  return (
    <group>
      <RoundedBox args={[w, h, t]} radius={Math.min(1, t / 2.1)} smoothness={2}><Mat look={look} color={color} roughness={0.42} /></RoundedBox>
      <group position={[0, 0, t / 2]}>{children}</group>
    </group>
  );
}

function Chip({ look, w, h, x = 0, y = 0, rot = 0, t = 1.2 }: { look: Look; w: number; h: number; x?: number; y?: number; rot?: number; t?: number }) {
  return (
    <mesh position={[x, y, t / 2]} rotation={[0, 0, rot]}>
      <boxGeometry args={[w, h, t]} /><Mat look={look} color="#121316" roughness={0.35} />
    </mesh>
  );
}

function UsbPort({ look, w, x, y, rot = 0 }: { look: Look; w: number; x: number; y: number; rot?: number }) {
  return (
    <mesh position={[x, y, 2]} rotation={[0, 0, rot]}>
      <boxGeometry args={[w * 0.75, w, 3.6]} /><Mat look={look} {...STEEL} />
    </mesh>
  );
}

/** Arduino Nano: blue board, ATmega328 at 45°, mini-USB at one end, a row of pins down each long side. */
function Nano({ look, w, h }: { look: Look; w: number; h: number }) {
  const rows = Math.round((w - 4) / 2.54);
  return (
    <Pcb look={look} w={w} h={h} color="#0c4f9c">
      <Chip look={look} w={7} h={7} rot={Math.PI / 4} />
      <Chip look={look} w={4} h={3} x={-w * 0.22} y={0} />
      <UsbPort look={look} w={7.5} x={-w / 2 + 2.6} y={0} rot={Math.PI / 2} />
      <mesh position={[w * 0.28, 0, 0.9]}><boxGeometry args={[3, 3, 1.8]} /><Mat look={look} {...STEEL} /></mesh>
      <mesh position={[w * 0.28, 0, 1.9]}><cylinderGeometry args={[0.9, 0.9, 0.6, 16]} /><Mat look={look} color="#e8e8e8" /></mesh>
      <mesh position={[w * 0.1, h * 0.2, 0.5]}><boxGeometry args={[1.6, 0.8, 0.6]} /><Mat look={look} color="#3ad06a" glow={look === "real" ? "#58ff8a" : undefined} /></mesh>
      <Header look={look} n={rows} x={0} y={h / 2 - 1.5} z={-1.6} />
      <Header look={look} n={rows} x={0} y={-h / 2 + 1.5} z={-1.6} />
    </Pcb>
  );
}

/** ESP32 DevKit: black board, silver Wi-Fi can, USB at one end. */
function Esp32({ look, w, h }: { look: Look; w: number; h: number }) {
  const rows = Math.round((w - 6) / 2.54);
  return (
    <Pcb look={look} w={w} h={h} color="#16181d">
      <mesh position={[w * 0.18, 0, 1.5]}><boxGeometry args={[w * 0.32, h * 0.62, 3]} /><Mat look={look} {...STEEL} /></mesh>
      <mesh position={[w * 0.42, 0, 0.4]}><boxGeometry args={[w * 0.12, h * 0.62, 0.8]} /><Mat look={look} color="#202226" /></mesh>
      <UsbPort look={look} w={8} x={-w / 2 + 2.8} y={0} rot={Math.PI / 2} />
      <Chip look={look} w={5} h={5} x={-w * 0.18} y={0} />
      <Header look={look} n={rows} x={0} y={h / 2 - 1.5} z={-1.6} />
      <Header look={look} n={rows} x={0} y={-h / 2 + 1.5} z={-1.6} />
    </Pcb>
  );
}

/** DFPlayer Mini: small blue square with a microSD slot on top. */
function Player({ look, w, h }: { look: Look; w: number; h: number }) {
  return (
    <Pcb look={look} w={w} h={h} color="#1a3f8f">
      <mesh position={[0, 0, 1]}><boxGeometry args={[w * 0.72, h * 0.68, 2]} /><Mat look={look} {...STEEL} /></mesh>
      <mesh position={[0, -h * 0.1, 2.05]}><boxGeometry args={[w * 0.55, h * 0.45, 0.2]} /><Mat look={look} color="#1d1f24" /></mesh>
      <Header look={look} n={8} x={-w / 2 + 1.5} y={0} along="y" z={-1.6} />
      <Header look={look} n={8} x={w / 2 - 1.5} y={0} along="y" z={-1.6} />
    </Pcb>
  );
}

/** TTP223 touch module: small red board with the round touch pad. */
function Touch({ look, w, h }: { look: Look; w: number; h: number }) {
  return (
    <Pcb look={look} w={w} h={h} color="#b3262c">
      <mesh position={[w * 0.12, 0, 0.1]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[h * 0.38, h * 0.38, 0.2, 40]} /><Mat look={look} {...GOLD} /></mesh>
      <Chip look={look} w={3} h={2.4} x={-w * 0.25} y={0} t={1} />
      <Header look={look} n={3} x={-w / 2 + 1.5} y={0} along="y" z={-1.6} />
    </Pcb>
  );
}

/** Any other small module: green board, a chip, a pin row. */
function Module({ look, w, h, color = "#1f6e3b" }: { look: Look; w: number; h: number; color?: string }) {
  return (
    <Pcb look={look} w={w} h={h} color={color}>
      <Chip look={look} w={Math.min(6, w * 0.3)} h={Math.min(6, h * 0.35)} />
      <Header look={look} n={Math.max(3, Math.min(8, Math.round(w / 4)))} x={0} y={-h / 2 + 1.5} z={-1.6} />
    </Pcb>
  );
}

/** A round speaker: steel frame, black paper cone, dust cap, magnet underneath, two solder tabs. */
function Speaker({ look, w, d }: { look: Look; w: number; d: number }) {
  const r = w / 2;
  const cone = useMemo(() => new THREE.LatheGeometry([
    new THREE.Vector2(r * 0.22, 0), new THREE.Vector2(r * 0.5, d * 0.18), new THREE.Vector2(r * 0.82, d * 0.36), new THREE.Vector2(r * 0.86, d * 0.38),
  ], 48), [r, d]);
  useEffect(() => () => cone.dispose(), [cone]);
  return (
    <group rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -d / 2]}>
      <mesh position={[0, d * 0.2, 0]}><cylinderGeometry args={[r * 0.45, r * 0.45, d * 0.4, 40]} /><Mat look={look} color="#2b2d31" metalness={0.6} roughness={0.35} /></mesh>
      <mesh position={[0, d * 0.42, 0]}><cylinderGeometry args={[r * 0.52, r * 0.52, d * 0.06, 40]} /><Mat look={look} {...STEEL} /></mesh>
      <mesh position={[0, d * 0.45, 0]}><primitive object={cone} attach="geometry" /><Mat look={look} color="#121212" roughness={0.9} /></mesh>
      <mesh position={[0, d * 0.83, 0]}><torusGeometry args={[r * 0.9, r * 0.07, 10, 64]} /><Mat look={look} color="#1a1a1a" roughness={0.8} /></mesh>
      <mesh position={[0, d * 0.83, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[r * 0.98, r * 0.04, 8, 64]} /><Mat look={look} {...STEEL} /></mesh>
      <mesh position={[0, d * 0.5, 0]}><sphereGeometry args={[r * 0.22, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><Mat look={look} color="#1d1d1d" roughness={0.6} /></mesh>
      {[-1, 1].map((k) => (
        <mesh key={k} position={[k * r * 0.62, d * 0.5, r * 0.55]}><boxGeometry args={[2.5, 0.4, 4]} /><Mat look={look} {...GOLD} /></mesh>
      ))}
    </group>
  );
}

/** A WS2812 ring: black ring board with twelve white 5050 LEDs, lit in colour. */
function Ring({ look, w, lit }: { look: Look; w: number; lit: boolean }) {
  const ro = w / 2, ri = ro * 0.62;
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.absarc(0, 0, ro, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, ri, 0, Math.PI * 2, true);
    s.holes.push(hole);
    return s;
  }, [ro, ri]);
  const colors = ["#ffcf5a", "#ffb347", "#ff8f6b", "#ff6b9d", "#c77dff", "#7aa2ff", "#46e2ff", "#5df0b0", "#b6f36a", "#ffe066", "#ffd166", "#ffc94a"];
  return (
    <group>
      <mesh position={[0, 0, -0.8]}><extrudeGeometry args={[shape, { depth: 1.6, bevelEnabled: false, curveSegments: 48 }]} /><Mat look={look} color="#141519" roughness={0.45} /></mesh>
      {colors.map((c, i) => {
        const a = (i / 12) * Math.PI * 2, rr = (ro + ri) / 2;
        return (
          <group key={i} position={[Math.cos(a) * rr, Math.sin(a) * rr, 1.6]} rotation={[0, 0, a]}>
            <mesh><boxGeometry args={[5, 5, 1.6]} /><Mat look={look} color="#f4f4f2" roughness={0.3} /></mesh>
            <mesh position={[0, 0, 0.82]}><circleGeometry args={[1.7, 20]} /><Mat look={look} color="#fafafa" glow={lit ? c : undefined} /></mesh>
          </group>
        );
      })}
    </group>
  );
}

function UsbPower({ look, w, h }: { look: Look; w: number; h: number }) {
  return (
    <Pcb look={look} w={w} h={h} color="#141519">
      <mesh position={[-w / 2 + 4.5, 0, 1.6]}><boxGeometry args={[7.5, 9, 3.2]} /><Mat look={look} {...STEEL} /></mesh>
      <Chip look={look} w={3} h={3} x={w * 0.15} y={0} />
    </Pcb>
  );
}

function Battery({ look, w, h, d, cells }: { look: Look; w: number; h: number; d: number; cells: number }) {
  return (
    <group>
      <RoundedBox args={[w, h, d]} radius={1.5} smoothness={2}><Mat look={look} color="#191a1d" roughness={0.6} /></RoundedBox>
      {Array.from({ length: cells }, (_, i) => (
        <mesh key={i} position={[0, -h / 2 + (h / cells) * (i + 0.5), d / 2 - 0.2]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[Math.min(7, h / cells / 2.2), Math.min(7, h / cells / 2.2), w * 0.86, 24]} /><Mat look={look} color={i % 2 ? "#2a5fd1" : "#d9a520"} metalness={0.4} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

function Lipo({ look, w, h, d }: { look: Look; w: number; h: number; d: number }) {
  return (
    <group>
      <RoundedBox args={[w, h, d]} radius={Math.min(2, d / 2.2)} smoothness={3}><Mat look={look} color="#bfc6cf" metalness={0.5} roughness={0.35} /></RoundedBox>
      <mesh position={[0, 0, d / 2 + 0.05]}><planeGeometry args={[w * 0.8, h * 0.6]} /><Mat look={look} color="#2a62c9" /></mesh>
    </group>
  );
}

/** The right model for a piece of the stack. */
export function PartModel({ piece, look, lit }: { piece: Piece; look: Look; lit: boolean }) {
  const [w, h, d] = piece.size;
  switch (piece.id) {
    case "nano": return <Nano look={look} w={w} h={h} />;
    case "esp32": return <Esp32 look={look} w={w} h={h} />;
    case "player": return <Player look={look} w={w} h={h} />;
    case "touch": return <Touch look={look} w={w} h={h} />;
    case "speaker": return <Speaker look={look} w={Math.max(w, h)} d={d} />;
    case "ring": return <Ring look={look} w={Math.max(w, h)} lit={lit} />;
    case "usb": case "boost5": return <UsbPower look={look} w={w} h={h} />;
    case "aa3": return <Battery look={look} w={w} h={h} d={d} cells={3} />;
    case "aa4nimh": return <Battery look={look} w={w} h={h} d={d} cells={4} />;
    case "lipo": return <Lipo look={look} w={w} h={h} d={d} />;
    case "amp": return <Module look={look} w={w} h={h} color="#3b2a7a" />;
    case "mic": return <Module look={look} w={w} h={h} color="#1f6e3b" />;
    case "led": return (
      <group>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 2]}><cylinderGeometry args={[2.5, 2.5, 4, 24]} /><Mat look={look} color="#ffe9a8" glow={lit ? "#ffd166" : undefined} /></mesh>
        <mesh position={[0, 0, 4.5]}><sphereGeometry args={[2.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><Mat look={look} color="#fff3c4" glow={lit ? "#ffd166" : undefined} /></mesh>
      </group>
    );
    default:
      if (piece.kind === "motor") return <RoundedBox args={[w, h, d]} radius={1.2}><Mat look={look} color="#2f62d9" roughness={0.45} /></RoundedBox>;
      return <Module look={look} w={w} h={h} color={piece.kind === "board" ? "#1f6e3b" : "#3a4556"} />;
  }
}

/** One half of the body. Real: frosted moulded plastic that lets the light through. Holo: glowing outline. */
export function ShellHalf({ tris, look, top }: { tris: Tri[]; look: Look; top: boolean }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(tris.flat()), 3));
    g.computeVertexNormals();
    return g;
  }, [tris]);
  useEffect(() => () => geo.dispose(), [geo]);
  if (look === "holo") {
    return (
      <group>
        <mesh geometry={geo}><meshBasicMaterial color={HOLO} transparent opacity={top ? 0.08 : 0.14} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
        <lineSegments><edgesGeometry args={[geo, 25]} /><lineBasicMaterial color={HOLO} transparent opacity={0.9} /></lineSegments>
      </group>
    );
  }
  return (
    <mesh geometry={geo} castShadow receiveShadow>
      <meshPhysicalMaterial color={top ? "#fff6df" : "#f3ead6"} roughness={top ? 0.38 : 0.5} metalness={0} transmission={top ? 0.55 : 0.15}
        thickness={2.4} ior={1.46} clearcoat={0.5} clearcoatRoughness={0.3} sheen={0.3} sheenColor="#ffffff"
        transparent opacity={top ? 0.78 : 1} side={THREE.DoubleSide} depthWrite={!top} />
    </mesh>
  );
}
