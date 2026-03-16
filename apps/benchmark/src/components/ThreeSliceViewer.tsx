import React, { useRef, useEffect, useCallback } from 'react';
import type { Spine } from '@esotericsoftware/spine-pixi-v8';
import type { SliceLayer } from '../hooks/useZSlice';
import { getPixiApp } from '../hooks/usePixiApp';
import { Matrix, Rectangle, RenderTexture } from 'pixi.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ── Constants ─────────────────────────────────────────────────────── */
const BG_COLOR = 0x1a1a2e;
const GRID_COLOR = 0x333355;
const LABEL_FONT = '600 11px "Inter", system-ui, sans-serif';
/** How many animation frames to skip between full texture recaptures */
const CAPTURE_EVERY_N_FRAMES = 4;

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

/* ── Texture capture via PIXI ─────────────────────────────────────── */

interface LayerCapture {
  canvas: HTMLCanvasElement;
  threeTex: THREE.CanvasTexture;
}

/**
 * Capture each layer into its own canvas by temporarily nulling-out
 * the attachments of every slot that does NOT belong to the layer.
 *
 * Why attachment-nulling instead of slot.color.a?
 *   spine-pixi-v8's SpinePipe caches colour data in per-attachment
 *   objects and only recomputes them when `_stateChanged` is true
 *   (set exclusively by the animation system).  Changing slot.color.a
 *   externally never flips that flag ⇒ stale cache ⇒ every layer
 *   looks identical.  Setting attachment = null is picked up directly
 *   by addRenderable/updateRenderable (they skip null-attachment slots
 *   via an `instanceof` check), so no cache issue.
 *
 * Why slot names instead of draw-indices?
 *   Spine animations can include draw-order keys that rearrange the
 *   drawOrder array at runtime.  The indices stored in SliceSlotInfo
 *   are captured once at layer-creation time and may be stale.
 *   Matching by slot.data.name is animation-safe.
 *
 * Why a shared RenderTexture + explicit frame?
 *   extract.canvas({ target }) internally calls generateTexture which
 *   computes bounds from the container.  After we null-out most
 *   attachments the bounding box shrinks, producing a tiny texture
 *   that only covers the surviving slots.  Each layer would have
 *   different dimensions / origins and they would not stack correctly
 *   in the Three.js viewer.  By capturing the full-skeleton bounds
 *   BEFORE any modifications and rendering into a fixed-size RT we
 *   guarantee all layers share the same frame.
 *
 * Why `structureDidChange = true`?
 *   PixiJS 8's RenderGroupSystem caches the instruction set for each
 *   render group.  After the first render, subsequent renders reuse
 *   the cached instructions via `updateRenderable()` which only
 *   updates EXISTING batch elements — it does NOT remove slots that
 *   became null.  Setting structureDidChange forces a full rebuild
 *   via `addRenderable()` which re-walks drawOrder, skipping nulls.
 */
function captureAllLayers(
  spine: Spine,
  layers: SliceLayer[],
  cache: Map<string, LayerCapture>,
): void {
  const app = getPixiApp();
  if (!app || !spine.skeleton) return;

  const renderer = app.renderer;
  const skeleton = spine.skeleton;
  const drawOrder = skeleton.drawOrder;
  if (drawOrder.length === 0) return;

  // ── 1. Snapshot full bounds BEFORE any attachment changes ────────
  //    We need the bounds in spine's local coordinate space so the
  //    translate transform in step 3 maps correctly.
  const lb = spine.getLocalBounds();
  const fw = Math.ceil(lb.width);
  const fh = Math.ceil(lb.height);
  if (fw <= 0 || fh <= 0) return;
  const frame = new Rectangle(lb.x, lb.y, fw, fh);

  // ── 2. Save every slot's current attachment (keyed by array index) ─
  const savedAttachments: (unknown | null)[] = new Array(drawOrder.length);
  for (let i = 0; i < drawOrder.length; i++) {
    savedAttachments[i] = drawOrder[i].attachment;
  }

  // Create a reusable RenderTexture at full-skeleton size
  const rt = RenderTexture.create({ width: fw, height: fh, resolution: 1 });

  for (const layer of layers) {
    // Build a Set of slot NAMES that belong to this layer
    const visibleNames = new Set(layer.slots.map((s) => s.slotName));

    // ── 3. Null-out attachments for hidden slots ───────────────────
    for (let i = 0; i < drawOrder.length; i++) {
      const slot = drawOrder[i];
      if (visibleNames.has(slot.data.name)) {
        // Restore original attachment (may have been null'd by prev layer)
        slot.attachment = savedAttachments[i] as any;
      } else {
        slot.attachment = null;
      }
    }

    // ── 4. Force spine + render-group to fully rebuild ─────────────
    spine.spineAttachmentsDirty = true;
    // _stateChanged gates _validateAndTransformAttachments; without
    // it the pipe skips the full validation/transform pass.
    (spine as any)._stateChanged = true;

    // Ensure spine has a render group (renderer.render will call
    // enableRenderGroup anyway, but we need the ref now to set
    // structureDidChange).
    if (typeof (spine as any).enableRenderGroup === 'function') {
      (spine as any).enableRenderGroup();
    }
    const rg = (spine as any).renderGroup;
    if (rg) {
      rg.structureDidChange = true;
    }

    // ── 5. Render spine into our fixed-size RT ─────────────────────
    try {
      const transform = new Matrix();
      transform.translate(-frame.x, -frame.y);
      renderer.render({
        container: spine,
        target: rt,
        clear: true,
        transform,
      });
    } catch {
      continue;
    }

    // ── 6. Read back pixels from the RT into a canvas ──────────────
    let captured: HTMLCanvasElement;
    try {
      captured = renderer.extract.canvas({ target: rt }) as HTMLCanvasElement;
    } catch {
      continue;
    }

    // ── 7. Copy into the Three.js texture cache ────────────────────
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
  }

  // ── 8. Restore all attachments + dirty flags for normal rendering ─
  for (let i = 0; i < drawOrder.length; i++) {
    drawOrder[i].attachment = savedAttachments[i] as any;
  }
  spine.spineAttachmentsDirty = true;
  (spine as any)._stateChanged = true;
  const rg = (spine as any).renderGroup;
  if (rg) {
    rg.structureDidChange = true;
  }

  rt.destroy(true);
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
  /** Per-layer captured texture cache (persistent across frames) */
  const texCacheRef = useRef<Map<string, LayerCapture>>(new Map());
  /** Frame counter to throttle captures */
  const frameCtrRef = useRef(0);
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

    // Render loop (texture capture runs inside here)
    function animate() {
      frameRef.current = requestAnimationFrame(animate);
      frameCtrRef.current++;
      controls.update();

      // Capture layer textures every N frames
      const sp = spineRef.current;
      const lrs = layersRef.current;
      if (sp && lrs.length > 0 && frameCtrRef.current % CAPTURE_EVERY_N_FRAMES === 0) {
        captureAllLayers(sp, lrs, texCacheRef.current);

        // Update plane materials with captured textures
        for (const [layerId, group] of layerGroupsRef.current) {
          const cap = texCacheRef.current.get(layerId);
          if (!cap) continue;
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
    };
  }, []);

  /* ── Rebuild layer meshes ─────────────────────────────────────── */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Clean up old groups + old texture cache
    for (const [, group] of layerGroupsRef.current) {
      scene.remove(group);
      group.traverse((obj) => {
        if ((obj as any).geometry) (obj as any).geometry.dispose();
        if ((obj as any).material) {
          const mat = (obj as any).material;
          // Don't dispose shared captured textures here – cache owns them
          if (mat.map && !mat.userData?.isCapture) mat.map.dispose();
          mat.dispose();
        }
      });
    }
    layerGroupsRef.current.clear();

    // Dispose old texture cache entries that no longer match a layer
    const currentLayerIds = new Set(layers.map((l) => l.id));
    for (const [id, cap] of texCacheRef.current) {
      if (!currentLayerIds.has(id)) {
        cap.threeTex.dispose();
        texCacheRef.current.delete(id);
      }
    }

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

      // Textured plane (starts transparent white; texture filled by capture loop)
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

      // Fallback tinted plane behind the texture (visible until first capture)
      const fallbackGeo = new THREE.PlaneGeometry(w, h);
      const fallbackMat = new THREE.MeshBasicMaterial({
        color: hexToThree(layer.color),
        transparent: true,
        opacity: existingCap ? 0 : 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const fallback = new THREE.Mesh(fallbackGeo, fallbackMat);
      fallback.position.set(0, 0, z - 0.01); // slightly behind
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
        // Textured plane
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
        // Fallback plane
        if ((obj as THREE.Mesh).isMesh && obj.userData?.isFallback) {
          const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = isIsolated ? (texCacheRef.current.has(layerId) ? 0 : 0.18) : 0.03;
        }
        // Sprites (labels)
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
