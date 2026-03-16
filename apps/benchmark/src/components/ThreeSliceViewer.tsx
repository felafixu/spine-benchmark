import React, { useRef, useEffect, useCallback } from 'react';
import type { Spine } from '@esotericsoftware/spine-pixi-v8';
import type { SliceLayer } from '../hooks/useZSlice';
import { getPixiApp } from '../hooks/usePixiApp';
import { Matrix, RenderTexture } from 'pixi.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ── Constants ─────────────────────────────────────────────────────── */
const BG_COLOR = 0x1a1a2e;
const GRID_COLOR = 0x333355;
const LABEL_FONT = '600 11px "Inter", system-ui, sans-serif';

/* ── Helpers ───────────────────────────────────────────────────────── */

function hexToThree(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

function createLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  canvas.width = 512;
  canvas.height = 48;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = LABEL_FONT;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let display = text;
  if (ctx.measureText(display).width > 480) {
    while (ctx.measureText(display + '...').width > 480 && display.length > 0) {
      display = display.slice(0, -1);
    }
    display += '...';
  }
  ctx.fillText(display, 8, 24);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(4, 0.4, 1);
  return sprite;
}

function createLayerOutline(
  width: number,
  height: number,
  color: string,
): THREE.Line {
  const hw = width / 2;
  const hh = height / 2;
  const points = [
    new THREE.Vector3(-hw, -hh, 0),
    new THREE.Vector3(hw, -hh, 0),
    new THREE.Vector3(hw, hh, 0),
    new THREE.Vector3(-hw, hh, 0),
    new THREE.Vector3(-hw, -hh, 0),
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: hexToThree(color) });
  return new THREE.Line(geometry, material);
}

/* ── Per-layer texture cache entry ────────────────────────────────── */

interface LayerCapture {
  canvas: HTMLCanvasElement;
  threeTex: THREE.CanvasTexture;
}

/* ── Incremental single-layer capture ─────────────────────────────── *
 *
 * Instead of capturing ALL layers in one frame (N render passes +
 * N GPU read-backs ⇒ huge frame spike), we capture ONE layer per
 * animation frame in round-robin order.  A full texture refresh
 * therefore takes `layers.length` frames, but each individual frame
 * only does 1 PIXI render + 1 readPixels, keeping the frame budget
 * smooth.
 *
 * The RenderTexture and transform Matrix are created once and reused
 * across all captures to avoid per-frame allocation / GC pressure.
 * ------------------------------------------------------------------ */

interface CaptureState {
  /** Reusable RT sized to the full skeleton */
  rt: RenderTexture;
  /** Reusable affine transform */
  transform: Matrix;
  /** Current RT dimensions (to detect skeleton resize) */
  rtW: number;
  rtH: number;
  /** Last known local-bounds origin */
  lbX: number;
  lbY: number;
  /** Has enableRenderGroup been called once? */
  rgReady: boolean;
}

/**
 * Capture exactly ONE layer, returning the layer ID that was captured
 * (or null if nothing was captured).
 */
function captureOneLayer(
  spine: Spine,
  layer: SliceLayer,
  cache: Map<string, LayerCapture>,
  state: CaptureState,
): boolean {
  const app = getPixiApp();
  if (!app || !spine.skeleton) return false;

  const renderer = app.renderer;
  const skeleton = spine.skeleton;
  const drawOrder = skeleton.drawOrder;
  if (drawOrder.length === 0) return false;

  // ── Ensure RT matches current skeleton bounds ──────────────────
  const lb = spine.getLocalBounds();
  const fw = Math.ceil(lb.width);
  const fh = Math.ceil(lb.height);
  if (fw <= 0 || fh <= 0) return false;

  if (fw !== state.rtW || fh !== state.rtH) {
    state.rt.resize(fw, fh);
    state.rtW = fw;
    state.rtH = fh;
  }
  state.lbX = lb.x;
  state.lbY = lb.y;

  // ── Save attachments ───────────────────────────────────────────
  const savedAttachments: (unknown | null)[] = new Array(drawOrder.length);
  for (let i = 0; i < drawOrder.length; i++) {
    savedAttachments[i] = drawOrder[i].attachment;
  }

  const visibleNames = new Set(layer.slots.map((s) => s.slotName));

  // ── Null-out hidden slots ──────────────────────────────────────
  for (let i = 0; i < drawOrder.length; i++) {
    const slot = drawOrder[i];
    if (!visibleNames.has(slot.data.name)) {
      slot.attachment = null;
    }
  }

  // ── Force spine + render-group to fully rebuild ────────────────
  spine.spineAttachmentsDirty = true;
  (spine as any)._stateChanged = true;

  if (!state.rgReady) {
    if (typeof (spine as any).enableRenderGroup === 'function') {
      (spine as any).enableRenderGroup();
    }
    state.rgReady = true;
  }
  const rg = (spine as any).renderGroup;
  if (rg) rg.structureDidChange = true;

  // ── Render + extract ───────────────────────────────────────────
  let ok = false;
  try {
    state.transform.identity();
    state.transform.translate(-state.lbX, -state.lbY);
    renderer.render({
      container: spine,
      target: state.rt,
      clear: true,
      transform: state.transform,
    });
    const captured = renderer.extract.canvas({ target: state.rt }) as HTMLCanvasElement;

    // Copy into Three.js texture cache
    const existing = cache.get(layer.id);
    if (existing) {
      const dstCtx = existing.canvas.getContext('2d');
      if (dstCtx) {
        existing.canvas.width = captured.width;
        existing.canvas.height = captured.height;
        dstCtx.clearRect(0, 0, captured.width, captured.height);
        dstCtx.drawImage(captured, 0, 0);
        existing.threeTex.needsUpdate = true;
      }
    } else {
      const persistent = document.createElement('canvas');
      persistent.width = captured.width;
      persistent.height = captured.height;
      const pCtx = persistent.getContext('2d');
      if (pCtx) pCtx.drawImage(captured, 0, 0);
      const tex = new THREE.CanvasTexture(persistent);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      cache.set(layer.id, { canvas: persistent, threeTex: tex });
    }
    ok = true;
  } catch {
    // silently skip
  }

  // ── Restore attachments ────────────────────────────────────────
  for (let i = 0; i < drawOrder.length; i++) {
    drawOrder[i].attachment = savedAttachments[i] as any;
  }
  spine.spineAttachmentsDirty = true;
  (spine as any)._stateChanged = true;
  if (rg) rg.structureDidChange = true;

  return ok;
}

/* ── Component ─────────────────────────────────────────────────────── */

interface ThreeSliceViewerProps {
  spine: Spine | null;
  layers: SliceLayer[];
  layerSpacing: number;
  hoveredLayerId: string | null;
  isolatedLayerId: string | null;
  onHoverLayer: (id: string | null) => void;
  onIsolateLayer: (id: string | null) => void;
}

export function ThreeSliceViewer({
  spine,
  layers,
  layerSpacing,
  hoveredLayerId,
  isolatedLayerId,
  onHoverLayer,
  onIsolateLayer,
}: ThreeSliceViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameRef = useRef<number>(0);
  const layerGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());

  /** Per-layer captured texture cache */
  const texCacheRef = useRef<Map<string, LayerCapture>>(new Map());
  /** Round-robin index – which layer to capture next */
  const captureIdxRef = useRef(0);
  /** Persistent capture state (RT, transform, etc.) */
  const captureStateRef = useRef<CaptureState | null>(null);

  /** Reference to the current layer list (avoids stale closure) */
  const layersRef = useRef(layers);
  layersRef.current = layers;
  /** Reference to spine */
  const spineRef = useRef(spine);
  spineRef.current = spine;

  // Determine plane dimensions from skeleton bounds
  const getSkeletonBounds = useCallback(() => {
    if (!spine) return { w: 6, h: 8 };
    const bounds = spine.getBounds();
    if (bounds.width > 0 && bounds.height > 0) {
      return {
        w: Math.max(bounds.width / 100, 2),
        h: Math.max(bounds.height / 100, 2),
      };
    }
    const data = spine.skeleton?.data;
    return {
      w: Math.max((data?.width ?? 400) / 100, 2),
      h: Math.max((data?.height ?? 600) / 100, 2),
    };
  }, [spine]);

  /* ── Three.js scene init ──────────────────────────────────────── */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(8, 6, 12);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // Subtle grid
    const gridHelper = new THREE.GridHelper(20, 20, GRID_COLOR, 0x222244);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.position.z = -1;
    scene.add(gridHelper);

    scene.add(new THREE.AmbientLight(0xffffff, 1));

    // Resize
    const observer = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    observer.observe(container);

    // ── Render loop ────────────────────────────────────────────────
    function animate() {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();

      const sp = spineRef.current;
      const lrs = layersRef.current;

      // Capture ONE layer per frame (round-robin)
      if (sp && lrs.length > 0) {
        // Lazily create capture state
        if (!captureStateRef.current) {
          captureStateRef.current = {
            rt: RenderTexture.create({ width: 2, height: 2, resolution: 1 }),
            transform: new Matrix(),
            rtW: 2,
            rtH: 2,
            lbX: 0,
            lbY: 0,
            rgReady: false,
          };
        }

        // Clamp index
        if (captureIdxRef.current >= lrs.length) {
          captureIdxRef.current = 0;
        }

        const layer = lrs[captureIdxRef.current];
        const ok = captureOneLayer(sp, layer, texCacheRef.current, captureStateRef.current);

        if (ok) {
          // Bind texture to the matching Three.js plane (once)
          const group = layerGroupsRef.current.get(layer.id);
          const cap = texCacheRef.current.get(layer.id);
          if (group && cap) {
            group.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh && obj.userData?.isTexPlane) {
                const mesh = obj as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
                if (mesh.material.map !== cap.threeTex) {
                  mesh.material.map = cap.threeTex;
                  mesh.material.needsUpdate = true;
                }
                cap.threeTex.needsUpdate = true;
              }
            });
          }
        }

        captureIdxRef.current++;
      }

      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      // Destroy persistent RT
      if (captureStateRef.current) {
        captureStateRef.current.rt.destroy(true);
        captureStateRef.current = null;
      }
    };
  }, []);

  /* ── Rebuild layer meshes ─────────────────────────────────────── */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clean up old groups
    for (const [, group] of layerGroupsRef.current) {
      scene.remove(group);
      group.traverse((obj) => {
        if ((obj as any).geometry) (obj as any).geometry.dispose();
        if ((obj as any).material) {
          const mat = (obj as any).material;
          if (mat.map && !mat.userData?.isCapture) mat.map.dispose();
          mat.dispose();
        }
      });
    }
    layerGroupsRef.current.clear();

    // Dispose stale texture cache entries
    const currentLayerIds = new Set(layers.map((l) => l.id));
    for (const [id, cap] of texCacheRef.current) {
      if (!currentLayerIds.has(id)) {
        cap.threeTex.dispose();
        texCacheRef.current.delete(id);
      }
    }

    // Reset round-robin so new layers get captured immediately
    captureIdxRef.current = 0;

    if (layers.length === 0) return;

    const { w, h } = getSkeletonBounds();
    const spacing = layerSpacing / 10;
    const totalHeight = (layers.length - 1) * spacing;
    const startZ = -totalHeight / 2;

    layers.forEach((layer, i) => {
      const group = new THREE.Group();
      group.userData = { layerId: layer.id, layerIndex: i };
      // Reverse: layer[0] (back / lowest draw-order) at the TOP of the
      // stack so the camera looks down through foreground → background.
      const z = startZ + (layers.length - 1 - i) * spacing;

      // Textured plane
      const geo = new THREE.PlaneGeometry(w, h);
      const existingCap = texCacheRef.current.get(layer.id);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: existingCap?.threeTex ?? null,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const texPlane = new THREE.Mesh(geo, mat);
      texPlane.position.set(0, 0, z);
      texPlane.userData = { layerId: layer.id, isTexPlane: true };
      group.add(texPlane);

      // Fallback tinted plane behind the texture
      const fallbackGeo = new THREE.PlaneGeometry(w, h);
      const fallbackMat = new THREE.MeshBasicMaterial({
        color: hexToThree(layer.color),
        transparent: true,
        opacity: existingCap ? 0 : 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const fallback = new THREE.Mesh(fallbackGeo, fallbackMat);
      fallback.position.set(0, 0, z - 0.01);
      fallback.userData = { isFallback: true };
      group.add(fallback);

      // Wireframe border
      const outline = createLayerOutline(w, h, layer.color);
      outline.position.set(0, 0, z);
      group.add(outline);

      // Label
      const label = createLabelSprite(layer.label, layer.color);
      label.position.set(w / 2 + 2.2, 0, z);
      group.add(label);

      // Slot count badge
      const countLabel = createLabelSprite(
        `${layer.slots.length} slot${layer.slots.length !== 1 ? 's' : ''}`,
        '#888',
      );
      countLabel.position.set(w / 2 + 2.2, -0.5, z);
      countLabel.scale.set(2.5, 0.25, 1);
      group.add(countLabel);

      scene.add(group);
      layerGroupsRef.current.set(layer.id, group);
    });

    // Reposition camera
    if (cameraRef.current && controlsRef.current) {
      const maxDim = Math.max(w, h, totalHeight);
      cameraRef.current.position.set(maxDim * 1.2, maxDim * 0.8, maxDim * 1.5);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [layers, layerSpacing, getSkeletonBounds]);

  /* ── Hover / isolation visuals ────────────────────────────────── */
  useEffect(() => {
    for (const [layerId, group] of layerGroupsRef.current) {
      const isHovered = layerId === hoveredLayerId;
      const isIsolated = isolatedLayerId === null || layerId === isolatedLayerId;

      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh && obj.userData?.isTexPlane) {
          const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          if (!isIsolated) {
            mat.opacity = 0.08;
          } else if (isHovered) {
            mat.opacity = 1.0;
          } else {
            mat.opacity = 0.92;
          }
        }
        if ((obj as THREE.Mesh).isMesh && obj.userData?.isFallback) {
          const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = isIsolated ? (texCacheRef.current.has(layerId) ? 0 : 0.18) : 0.03;
        }
        if ((obj as THREE.Sprite).isSprite) {
          (obj as THREE.Sprite).material.opacity = isIsolated ? 1 : 0.15;
        }
      });

      group.visible = true;
    }
  }, [hoveredLayerId, isolatedLayerId, layers]);

  /* ── Raycasting for hover / click ─────────────────────────────── */
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    if (!renderer || !camera || !scene) return;
    const canvas = renderer.domElement;

    function getLayerIdFromIntersect(intersects: THREE.Intersection[]): string | null {
      for (const hit of intersects) {
        let obj: THREE.Object3D | null = hit.object;
        while (obj) {
          if (obj.userData?.layerId) return obj.userData.layerId;
          obj = obj.parent;
        }
      }
      return null;
    }

    function onPointerMove(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, camera!);
      const intersects = raycasterRef.current.intersectObjects(scene!.children, true);
      onHoverLayer(getLayerIdFromIntersect(intersects));
    }

    function onClick(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycasterRef.current.setFromCamera(mouseRef.current, camera!);
      const intersects = raycasterRef.current.intersectObjects(scene!.children, true);
      const id = getLayerIdFromIntersect(intersects);
      onIsolateLayer(id === isolatedLayerId ? null : id);
    }

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('click', onClick);
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('click', onClick);
    };
  }, [onHoverLayer, onIsolateLayer, isolatedLayerId]);

  return (
    <div
      ref={containerRef}
      className="zslice-three-container"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
