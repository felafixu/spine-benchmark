import React, { useRef, useEffect, useCallback } from 'react';
import type { Spine } from '@esotericsoftware/spine-pixi-v8';
import type { SliceLayer } from '../hooks/useZSlice';
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

/**
 * Create a text label sprite for a layer.
 */
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

  // Truncate if too long
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

/**
 * Build a colored translucent plane for a single layer.
 */
function createLayerPlane(
  width: number,
  height: number,
  color: string,
  opacity: number,
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({
    color: hexToThree(color),
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

/**
 * Create a wireframe outline for a layer plane.
 */
function createLayerOutline(
  width: number,
  height: number,
  color: string,
): THREE.LineSegments {
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
  return new THREE.Line(geometry, material) as unknown as THREE.LineSegments;
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

  // Determine plane dimensions from skeleton bounds
  const getSkeletonBounds = useCallback(() => {
    if (!spine) return { w: 6, h: 8 };
    // Use PIXI display bounds
    const bounds = spine.getBounds();
    if (bounds.width > 0 && bounds.height > 0) {
      const w = Math.max(bounds.width / 100, 2);
      const h = Math.max(bounds.height / 100, 2);
      return { w, h };
    }
    // Fallback to skeleton data dimensions
    const data = spine.skeleton?.data;
    const w = Math.max((data?.width ?? 400) / 100, 2);
    const h = Math.max((data?.height ?? 600) / 100, 2);
    return { w, h };
  }, [spine]);

  // Setup Three.js scene
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

    // Add subtle grid
    const gridHelper = new THREE.GridHelper(20, 20, GRID_COLOR, 0x222244);
    gridHelper.rotation.x = Math.PI / 2;
    gridHelper.position.z = -1;
    scene.add(gridHelper);

    // Ambient light (for potential future textured meshes)
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    // Resize observer
    const observer = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    observer.observe(container);

    // Animation loop
    function animate() {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
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

  // Rebuild layer meshes when layers or spacing change
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old layer groups
    for (const [, group] of layerGroupsRef.current) {
      scene.remove(group);
      group.traverse((obj) => {
        if ((obj as any).geometry) (obj as any).geometry.dispose();
        if ((obj as any).material) {
          const mat = (obj as any).material;
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      });
    }
    layerGroupsRef.current.clear();

    if (layers.length === 0) return;

    const { w, h } = getSkeletonBounds();
    const spacing = layerSpacing / 10; // normalize to scene units
    const totalHeight = (layers.length - 1) * spacing;
    const startZ = -totalHeight / 2;

    layers.forEach((layer, i) => {
      const group = new THREE.Group();
      group.userData = { layerId: layer.id, layerIndex: i };

      const z = startZ + i * spacing;

      // Translucent plane
      const plane = createLayerPlane(w, h, layer.color, 0.25);
      plane.position.set(0, 0, z);
      plane.userData = { layerId: layer.id };
      group.add(plane);

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

    // Reposition camera to see the full stack
    if (cameraRef.current && controlsRef.current) {
      const maxDim = Math.max(w, h, totalHeight);
      cameraRef.current.position.set(maxDim * 1.2, maxDim * 0.8, maxDim * 1.5);
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [layers, layerSpacing, getSkeletonBounds]);

  // Update hover / isolation visuals
  useEffect(() => {
    for (const [layerId, group] of layerGroupsRef.current) {
      const isHovered = layerId === hoveredLayerId;
      const isIsolated = isolatedLayerId === null || layerId === isolatedLayerId;

      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh && (obj as any).material) {
          const mat = (obj as any).material as THREE.MeshBasicMaterial;
          if (mat.opacity !== undefined) {
            if (!isIsolated) {
              mat.opacity = 0.06;
            } else if (isHovered) {
              mat.opacity = 0.55;
            } else {
              mat.opacity = 0.25;
            }
          }
        }
        if ((obj as THREE.Sprite).isSprite) {
          (obj as THREE.Sprite).material.opacity = isIsolated ? 1 : 0.15;
        }
      });

      group.visible = true;
    }
  }, [hoveredLayerId, isolatedLayerId, layers]);

  // Raycasting for hover / click
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
      const id = getLayerIdFromIntersect(intersects);
      onHoverLayer(id);
    }

    function onClick(e: MouseEvent) {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycasterRef.current.setFromCamera(mouseRef.current, camera!);
      const intersects = raycasterRef.current.intersectObjects(scene!.children, true);
      const id = getLayerIdFromIntersect(intersects);

      if (id === isolatedLayerId) {
        onIsolateLayer(null); // toggle off
      } else {
        onIsolateLayer(id);
      }
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
