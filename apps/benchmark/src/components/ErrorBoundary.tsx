import React, { ErrorInfo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TELEGRAM_REPORT_URL = 'https://t.me/+nwFiDd407Pk4Njdi';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('App error boundary caught an error', error, errorInfo);
    this.setState({ errorInfo });
  }

  public componentDidMount(): void {
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  public componentWillUnmount(): void {
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);
  }

  private handleWindowError = (event: ErrorEvent): void => {
    // Avoid re-triggering if already in error state
    if (this.state.hasError) return;

    // Ignore benign ResizeObserver loop notifications
    if (event.message?.includes('ResizeObserver loop')) return;

    const error = event.error instanceof Error
      ? event.error
      : new Error(event.message || 'Uncaught error');

    console.error('Global error caught by ErrorBoundary:', error);
    this.setState({ hasError: true, error, errorInfo: null });
  };

  private handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (this.state.hasError) return;

    const reason = event.reason;
    const error = reason instanceof Error
      ? reason
      : new Error(typeof reason === 'string' ? reason : 'Unhandled promise rejection');

    console.error('Unhandled rejection caught by ErrorBoundary:', error);
    this.setState({ hasError: true, error, errorInfo: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  public render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          onRetry={this.handleRetry}
          onReload={this.handleReload}
        />
      );
    }

    return this.props.children;
  }
}

function ErrorFallback({
  error,
  errorInfo,
  onRetry,
  onReload,
}: {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  onRetry: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);

  const errorMessage = error?.message || t('appErrorBoundary.unknownError');
  const errorStack = error?.stack || '';
  const componentStack = errorInfo?.componentStack || '';

  return (
    <div className="app-error-boundary">
      <div className="app-error-boundary-card">
        <h1>{t('appErrorBoundary.title')}</h1>
        <p>{t('appErrorBoundary.description')}</p>

        <div className="app-error-boundary-message">
          <code>{errorMessage}</code>
        </div>

        <button
          type="button"
          className="app-error-boundary-toggle"
          onClick={() => setShowDetails(!showDetails)}
        >
          {showDetails
            ? t('appErrorBoundary.hideError')
            : t('appErrorBoundary.showError')}
        </button>

        {showDetails && (
          <pre className="app-error-boundary-details">
            {errorStack}
            {componentStack && `\n\nComponent Stack:${componentStack}`}
          </pre>
        )}

        <div className="app-error-boundary-actions">
          <button type="button" className="secondary-btn" onClick={onRetry}>
            {t('appErrorBoundary.retry')}
          </button>
          <button type="button" className="primary-btn" onClick={onReload}>
            {t('appErrorBoundary.reload')}
          </button>
          <a
            className="secondary-btn app-error-boundary-report"
            href={TELEGRAM_REPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('appErrorBoundary.reportBug')}
          </a>
        </div>
      </div>
    </div>
  );
}
