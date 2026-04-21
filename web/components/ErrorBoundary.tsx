"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function isChunkLoadError(error: Error): boolean {
  const message = error.message || String(error);
  return (
    message.includes("Failed to load chunk") ||
    message.includes("ChunkLoadError") ||
    message.includes("Loading chunk") ||
    message.includes("/_next/static/chunks/")
  );
}

export class ErrorBoundary extends Component<Props, State> {
  private clearReloadGuard: number | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  componentDidMount() {
    if (typeof window === "undefined") return;
    this.clearReloadGuard = window.setTimeout(() => {
      window.sessionStorage.removeItem("tts-harness:chunk-load-reloaded");
    }, 5000);
  }

  componentWillUnmount() {
    if (this.clearReloadGuard !== null) {
      window.clearTimeout(this.clearReloadGuard);
    }
  }

  componentDidCatch(error: Error) {
    if (typeof window === "undefined" || !isChunkLoadError(error)) return;
    const key = "tts-harness:chunk-load-reloaded";
    if (window.sessionStorage.getItem(key) === "1") return;
    window.sessionStorage.setItem(key, "1");
    window.location.reload();
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 p-8">
          <div className="max-w-md text-center">
            <div className="text-red-500 dark:text-red-400 text-lg font-semibold mb-2">
              页面渲染失败
            </div>
            <div className="text-sm text-neutral-600 dark:text-neutral-400 mb-2">
              这通常是前端状态或组件渲染异常。你可以先尝试重新挂载页面，如果问题仍在，再刷新整个页面。
            </div>
            <div className="text-sm text-neutral-600 dark:text-neutral-400 font-mono break-all mb-4">
              {this.state.error.message || String(this.state.error)}
            </div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-4 py-2 text-sm rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                重新挂载
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm rounded bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
