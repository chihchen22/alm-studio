// apps/studio/src/viewerBase.ts
/** The workbench viewer: its dev server in dev, same origin in a build. */
export const VIEWER_BASE = import.meta.env.DEV ? "http://localhost:5173/" : "/";
