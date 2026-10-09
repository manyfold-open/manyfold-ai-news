// Vite replaces import.meta.env in the Worker bundle: DEV is true under `npm run dev`
// (and in vitest), false in builds. Declared optional so code guards for its absence.
interface ImportMetaEnv {
  readonly DEV?: boolean;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
