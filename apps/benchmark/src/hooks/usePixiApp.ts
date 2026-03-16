import { Application } from 'pixi.js';
import 'pixi.js/basis';
import 'pixi.js/ktx2';
import { useEffect, useRef, useState } from 'react';
import { useToast } from './ToastContext';
import { useTranslation } from 'react-i18next';
import { tIndexed } from '../utils/indexedMessage';

export interface UsePixiAppOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  backgroundColor: string;
}

let singletonApp: Application | null = null;
let singletonInitPromise: Promise<Application> | null = null;

const parseBackgroundColor = (value: string): number => parseInt(value.replace('#', '0x'), 16);

async function getOrCreateApp(container: HTMLDivElement, backgroundColor: string): Promise<Application> {
  if (singletonApp) {
    if (singletonApp.canvas.parentElement !== container) {
      container.appendChild(singletonApp.canvas);
    }
    singletonApp.renderer.background.color = parseBackgroundColor(backgroundColor);
    return singletonApp;
  }

  if (singletonInitPromise) {
    const app = await singletonInitPromise;
    if (app.canvas.parentElement !== container) {
      container.appendChild(app.canvas);
    }
    app.renderer.background.color = parseBackgroundColor(backgroundColor);
    return app;
  }

  singletonInitPromise = (async () => {
    const app = new Application();
    await app.init({
      backgroundColor: parseBackgroundColor(backgroundColor),
      antialias: true,
      resolution: 2,
      autoDensity: true,
    });
    app.canvas.id = 'pixiCanvas';
    container.appendChild(app.canvas);
    singletonApp = app;
    return app;
  })();

  try {
    return await singletonInitPromise;
  } finally {
    singletonInitPromise = null;
  }
}

/**
 * Initializes and manages the PIXI Application lifecycle.
 * Returns the app instance and cleans up on unmount.
 */
export function usePixiApp({ containerRef, backgroundColor }: UsePixiAppOptions) {
  const [app, setApp] = useState<Application | null>(null);
  const { addToast } = useToast();
  const { t } = useTranslation();
  const addToastRef = useRef(addToast);
  const tRef = useRef(t);
  const backgroundColorRef = useRef(backgroundColor);

  useEffect(() => {
    addToastRef.current = addToast;
    tRef.current = t;
  }, [addToast, t]);

  useEffect(() => {
    backgroundColorRef.current = backgroundColor;
  }, [backgroundColor]);

  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;

    const initWhenReady = async () => {
      if (cancelled) return;
      const container = containerRef.current;
      if (!container) {
        rafId = window.requestAnimationFrame(() => {
          void initWhenReady();
        });
        return;
      }

      try {
        const pixiApp = await getOrCreateApp(container, backgroundColorRef.current);
        if (!cancelled) setApp(pixiApp);
      } catch (error) {
        addToastRef.current(
          tIndexed(tRef.current, 'error.failedToInitialize', [
            error instanceof Error ? error.message : tRef.current('dashboard.messages.unknownError'),
          ]),
          'error'
        );
      }
    };

    void initWhenReady();

    return () => {
      cancelled = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      setApp(null);
    };
  }, [containerRef]);

  useEffect(() => {
    if (app) {
      app.renderer.background.color = parseBackgroundColor(backgroundColor);
    }
  }, [backgroundColor, app]);

  return app;
}
