import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const base = '/FYP_Jean_Prototype/';

/** The dev server answers 404 for the base path without its trailing slash, which is the address the app itself shows
 *  after you click Overview. Send it to the slash form so a reload there works (GitHub Pages already does this). */
const baseSlash = (): Plugin => ({
  name: 'base-trailing-slash',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [path, query] = (req.url ?? '').split('?');
      if (path === base.slice(0, -1)) {
        res.statusCode = 302;
        res.setHeader('Location', base + (query ? `?${query}` : ''));
        res.end();
        return;
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), baseSlash()],
  base,
});
