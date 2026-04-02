export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return import.meta.env.VITE_VARIANT || 'full';

  const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  if (isTauri) {
    // Branded desktop builds (spark, tech, etc.) always use the build-time variant
    // to prevent stale localStorage from a previous install overriding the theme.
    const buildVariant = import.meta.env.VITE_VARIANT;
    if (buildVariant && buildVariant !== 'full') return buildVariant;
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'spark') return stored;
    return buildVariant || 'full';
  }

  const h = location.hostname;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('happy.')) return 'happy';
  if (h.startsWith('spark.') || h === 'sparkmonitor.cn' || h === 'www.sparkmonitor.cn') return 'spark';

  if (h === 'localhost' || h === '127.0.0.1') {
    // VITE_VARIANT explicitly set at build/dev time takes priority over localStorage
    const envVariant = import.meta.env.VITE_VARIANT;
    if (envVariant) return envVariant;
    const stored = localStorage.getItem('worldmonitor-variant');
    if (stored === 'tech' || stored === 'full' || stored === 'finance' || stored === 'happy' || stored === 'spark') return stored;
    return 'full';
  }

  return import.meta.env.VITE_VARIANT || 'full';
})();
