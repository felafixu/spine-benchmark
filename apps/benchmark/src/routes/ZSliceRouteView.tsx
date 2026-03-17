import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkbench } from '../workbench/WorkbenchContext';
import { RouteHeaderCard } from '../components/RouteHeaderCard';
import { RouteStateCallout } from '../components/insights/MetricInsightTools';
import { ZSliceTimeline } from '../components/ZSliceTimeline';
import { ThreeSliceViewer } from '../components/ThreeSliceViewer';
import { useZSlice, SliceMode, BoneTreeNode } from '../hooks/useZSlice';
import { usePrerender } from '../hooks/usePrerender';
import { Lock, Unlock, ChevronRight, ChevronDown, Cpu, GitBranch, MousePointerClick } from 'lucide-react';

/* ── Bone tree renderer for custom-lock mode ──────────────────────── */

function BoneTreeItem({
  node,
  onToggleLock,
  depth,
}: {
  node: BoneTreeNode;
  onToggleLock: (name: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const slotCount = node.directSlots.length;

  return (
    <div className="zslice-tree-item" style={{ '--tree-depth': depth } as React.CSSProperties}>
      <div className={`zslice-tree-row${node.locked ? ' locked' : ''}`}>
        {hasChildren ? (
          <button
            type="button"
            className="zslice-tree-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="zslice-tree-toggle-spacer" />
        )}

        <button
          type="button"
          className={`zslice-lock-btn${node.locked ? ' is-locked' : ''}`}
          onClick={() => onToggleLock(node.name)}
          aria-label={node.locked ? 'Unlock subtree' : 'Lock subtree'}
          title={node.locked ? 'Unlock: split children into separate layers' : 'Lock: merge subtree into one layer'}
        >
          {node.locked ? <Lock size={12} /> : <Unlock size={12} />}
        </button>

        <span className="zslice-tree-name" title={node.name}>
          {node.name}
        </span>
        {slotCount > 0 && (
          <span className="zslice-tree-badge">{slotCount}</span>
        )}
      </div>

      {expanded && !node.locked && hasChildren && (
        <div className="zslice-tree-children">
          {node.children.map((child) => (
            <BoneTreeItem
              key={child.name}
              node={child}
              onToggleLock={onToggleLock}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Route View ───────────────────────────────────────────────────── */

export function ZSliceRouteView() {
  const { t } = useTranslation();
  const [isLoadingSelected, setIsLoadingSelected] = useState(false);
  const {
    spineInstance,
    isAnyLoading,
    loadingMessage,
    handleDrop,
    handleDragOver,
    handleDragLeave,
    assets,
    selectedAssetId,
    setSelectedAssetId,
    loadStoredAsset,
    loadCurrentAssetIntoBenchmark,
    lastLoadError,
    clearLastLoadError,
    loadFromUrls,
    uploadBundleFiles,
  } = useWorkbench();

  const {
    mode,
    setMode,
    treeDepth,
    setTreeDepth,
    maxTreeDepth,
    layers,
    boneTree,
    toggleLock,
    hoveredLayerId,
    setHoveredLayerId,
    isolatedLayerId,
    setIsolatedLayerId,
    layerSpacing,
    setLayerSpacing,
  } = useZSlice(spineInstance);

  /* ── Timeline + prerender state ────────────────────────────────── */
  const [animationName, setAnimationName] = useState('');
  const [skinName, setSkinName] = useState('');
  const [currentFrame, setCurrentFrame] = useState(0);

  const {
    frames: prerenderFrames,
    totalFrames,
    status: prerenderStatus,
    progress: prerenderProgress,
    prerender,
  } = usePrerender(spineInstance, layers);

  // Stable fingerprint so prerender only re-triggers when layer IDs actually change
  const layerFingerprint = useMemo(
    () => layers.map((l) => l.id).join('|'),
    [layers],
  );

  // Trigger prerender when animation, skin, or layer *structure* changes
  // Uses layerFingerprint (string) instead of layers (object ref) to avoid
  // re-triggering from DC polling that produces new arrays with same structure.
  useEffect(() => {
    if (animationName && spineInstance && layers.length > 0 && prerenderStatus !== 'prerendering') {
      setCurrentFrame(0);
      prerender(animationName, skinName);
    }
  }, [animationName, skinName, layerFingerprint, spineInstance, prerender]);

  // Compute skeleton size for Three.js planes
  const skeletonSize = useMemo(() => {
    if (!spineInstance) return { w: 6, h: 8 };
    const bounds = spineInstance.getBounds();
    if (bounds.width > 0 && bounds.height > 0) {
      return {
        w: Math.max(bounds.width / 100, 2),
        h: Math.max(bounds.height / 100, 2),
      };
    }
    const data = spineInstance.skeleton?.data;
    return {
      w: Math.max((data?.width ?? 400) / 100, 2),
      h: Math.max((data?.height ?? 600) / 100, 2),
    };
  }, [spineInstance]);

  const handleLoadSelected = async () => {
    setIsLoadingSelected(true);
    try {
      await loadCurrentAssetIntoBenchmark();
      clearLastLoadError();
    } finally {
      setIsLoadingSelected(false);
    }
  };

  const handlePickAsset = async (assetId: string) => {
    const asset = assets.find((entry) => entry.id === assetId);
    if (!asset) return;
    setIsLoadingSelected(true);
    try {
      setSelectedAssetId(assetId);
      await loadStoredAsset(asset);
      clearLastLoadError();
    } finally {
      setIsLoadingSelected(false);
    }
  };

  const MODE_OPTIONS: { value: SliceMode; icon: React.ReactNode; labelKey: string }[] = [
    { value: 'draw-call', icon: <Cpu size={14} />, labelKey: 'zSlice.modes.drawCall' },
    { value: 'tree-depth', icon: <GitBranch size={14} />, labelKey: 'zSlice.modes.treeDepth' },
    { value: 'custom-lock', icon: <MousePointerClick size={14} />, labelKey: 'zSlice.modes.customLock' },
  ];

  return (
    <div className="route-workspace">
      <RouteHeaderCard
        title={t('dashboard.tools.zSlice')}
        subtitle={t('zSlice.subtitle')}
        assetPicker={{
          assets,
          selectedAssetId,
          setSelectedAssetId: (id) => setSelectedAssetId(id),
          onUploadBundle: uploadBundleFiles,
          onPickAsset: handlePickAsset,
          onLoadFromUrl: loadFromUrls,
          isLoadingSelected,
        }}
      />

      <div className="zslice-layout">
        {/* ── Left panel: controls + layer list ────────────────────── */}
        <div className="tool-panel zslice-panel">
          {lastLoadError && (
            <RouteStateCallout
              kind="error"
              title={t('zSlice.states.loadError.title')}
              description={lastLoadError}
              actions={[
                { id: 'retry', label: t('zSlice.states.loadError.retry'), onClick: () => void handleLoadSelected(), variant: 'primary' },
                { id: 'dismiss', label: t('zSlice.states.loadError.dismiss'), onClick: clearLastLoadError, variant: 'secondary' },
              ]}
            />
          )}

          {!lastLoadError && isAnyLoading && (
            <RouteStateCallout
              kind="loading"
              title={t('zSlice.states.loading.title')}
              description={t('zSlice.states.loading.description')}
            />
          )}

          {spineInstance && !lastLoadError && (
            <>
              {/* Mode selector */}
              <div className="zslice-mode-selector">
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`zslice-mode-btn${mode === opt.value ? ' active' : ''}`}
                    onClick={() => setMode(opt.value)}
                  >
                    {opt.icon}
                    <span>{t(opt.labelKey)}</span>
                  </button>
                ))}
              </div>

              {/* Tree depth slider (only for tree-depth mode) */}
              {mode === 'tree-depth' && (
                <div className="zslice-depth-control">
                  <label className="zslice-control-label">
                    {t('zSlice.controls.depth')}: <strong>{treeDepth}</strong>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={maxTreeDepth}
                    value={treeDepth}
                    onChange={(e) => setTreeDepth(Number(e.target.value))}
                    className="zslice-slider"
                  />
                </div>
              )}

              {/* Spacing slider */}
              <div className="zslice-depth-control">
                <label className="zslice-control-label">
                  {t('zSlice.controls.spacing')}: <strong>{layerSpacing}</strong>
                </label>
                <input
                  type="range"
                  min={5}
                  max={100}
                  value={layerSpacing}
                  onChange={(e) => setLayerSpacing(Number(e.target.value))}
                  className="zslice-slider"
                />
              </div>

              {/* Bone tree for custom-lock mode */}
              {mode === 'custom-lock' && boneTree && (
                <div className="zslice-tree-container">
                  <div className="zslice-tree-header">{t('zSlice.boneTree.title')}</div>
                  <div className="zslice-tree-scroll">
                    <BoneTreeItem node={boneTree} onToggleLock={toggleLock} depth={0} />
                  </div>
                </div>
              )}

              {/* Layer list */}
              <div className="zslice-layer-list-header">
                <span>{mode === 'draw-call' ? t('zSlice.layerList.drawCalls') : t('zSlice.layerList.title')}</span>
                <span className="zslice-layer-count">{layers.length}</span>
              </div>
              <div className="zslice-layer-list">
                {layers.map((layer) => (
                  <button
                    key={layer.id}
                    type="button"
                    className={`zslice-layer-row${hoveredLayerId === layer.id ? ' hovered' : ''}${isolatedLayerId === layer.id ? ' isolated' : ''}${isolatedLayerId !== null && isolatedLayerId !== layer.id ? ' dimmed' : ''}`}
                    onMouseEnter={() => setHoveredLayerId(layer.id)}
                    onMouseLeave={() => setHoveredLayerId(null)}
                    onClick={() =>
                      setIsolatedLayerId(isolatedLayerId === layer.id ? null : layer.id)
                    }
                  >
                    <span
                      className="zslice-layer-swatch"
                      style={{ background: layer.color }}
                    />
                    <span className="zslice-layer-label" title={layer.label}>
                      {layer.label}
                    </span>
                    {layer.meta && (
                      <span className="zslice-layer-meta" title={layer.meta}>
                        {layer.meta}
                      </span>
                    )}
                    <span className="zslice-layer-slot-count">
                      {layer.slots.length}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {!lastLoadError && !isAnyLoading && !spineInstance && (
            <RouteStateCallout
              kind="empty"
              title={t('zSlice.empty.title')}
              description={t('zSlice.empty.hint')}
              actions={[
                { id: 'load-selected', label: t('toolRouteControls.actions.loadSelected'), onClick: () => void handleLoadSelected(), variant: 'primary' },
              ]}
            />
          )}
        </div>

        {/* ── Right panel: Three.js 3D viewer + animation controls ── */}
        <div
          className="zslice-canvas-area"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          {spineInstance && (
            <div className="zslice-anim-controls">
              <ZSliceTimeline
                spineInstance={spineInstance}
                totalFrames={totalFrames}
                currentFrame={currentFrame}
                onFrameChange={setCurrentFrame}
                prerenderStatus={prerenderStatus}
                prerenderProgress={prerenderProgress}
                onAnimationChange={setAnimationName}
                onSkinChange={setSkinName}
                animationName={animationName}
                skinName={skinName}
              />
            </div>
          )}

          <div className="zslice-canvas">
            {spineInstance ? (
              <ThreeSliceViewer
                layers={layers}
                layerSpacing={layerSpacing}
                prerenderFrames={prerenderFrames}
                currentFrame={currentFrame}
                skeletonSize={skeletonSize}
                reverseZOrder={mode !== 'draw-call'}
                hoveredLayerId={hoveredLayerId}
                isolatedLayerId={isolatedLayerId}
                onHoverLayer={setHoveredLayerId}
                onIsolateLayer={setIsolatedLayerId}
              />
            ) : (
              !isAnyLoading && (
                <div className="drop-area">
                  <p>{t('dashboard.workspace.dropArea')}</p>
                </div>
              )
            )}
            {isAnyLoading && (
              <div className="loading-indicator">
                <p>{loadingMessage}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
