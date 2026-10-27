/** React Router's stack index. Android WebView `canGoBack` stays false for these entries. */
export function historyIndex(): number {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' ? state.idx : 0;
}
