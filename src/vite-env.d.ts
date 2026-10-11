/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_ENV: 'development' | 'staging' | 'production';
  readonly VITE_FLAG_STUDIO: 'on' | 'off';
  readonly VITE_FLAG_ASSETS: 'on' | 'off';
  readonly VITE_FLAG_DISCOVER: 'on' | 'off';
  readonly VITE_FALLBACK_POLL_MS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
