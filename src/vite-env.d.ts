/// <reference types="vite/client" />

/** App version injected from package.json at build time via vite.config.ts */
declare const __APP_VERSION__: string;

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.jpg" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}
