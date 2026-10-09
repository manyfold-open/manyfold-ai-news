/**
 * Two apps share this entry: the reader (everything except /admin) and the admin
 * console at /admin (agent connections, chat and settings, reached only by URL).
 * Each is its own chunk with its own stylesheet, so neither restyles the other.
 */

import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';

const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/');
// One import() per lazy(): Vite attaches each chunk's stylesheet to its own import()
// call, and a ternary inside one call would load the reader's CSS for /admin too.
const Root = isAdmin ? lazy(() => import('./App')) : lazy(() => import('./reader/ReaderApp'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
);
