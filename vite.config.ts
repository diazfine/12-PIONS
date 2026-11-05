import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import path from 'path';
import {defineConfig, Plugin} from 'vite';

// LINT.IfChange(aistudio_media_plugin)
function aistudioMediaPlugin(): Plugin {
  return {
    name: 'vite-plugin-aistudio-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/assets/aistudio/')) {
          const rawPath = req.url.split('?')[0].split('#')[0];
          try {
            const decodedPath = decodeURIComponent(rawPath);
            const relativePath = decodedPath.replace(/^\//, '');
            const aistudioDir = path.resolve(
              __dirname,
              'public',
              'assets',
              'aistudio',
            );
            const filePath = path.resolve(__dirname, 'public', relativePath);
            if (
              filePath.startsWith(aistudioDir + path.sep) &&
              fs.existsSync(filePath) &&
              fs.statSync(filePath).isFile()
            ) {
              const ext = path.extname(filePath).toLowerCase();
              const mimeMap: Record<string, string> = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml',
                '.bmp': 'image/bmp',
                '.ico': 'image/x-icon',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.ogv': 'video/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
                '.pdf': 'application/pdf',
              };
              res.setHeader(
                'Content-Type',
                mimeMap[ext] || 'application/octet-stream',
              );
              res.setHeader('Cache-Control', 'no-cache');
              fs.createReadStream(filePath).pipe(res);
              return;
            }
          } catch {
            // Fall through if URI decoding or file access fails
          }
        }
        next();
      });
    },
  };
}
// LINT.ThenChange(//depot/google3/java/com/google/alkali/boq/makersuite/applet_dev_service/templates/initializers/react_theme/vite.config.ts:aistudio_media_plugin)

function suppressViteConsolePlugin(): Plugin {
  return {
    name: 'vite-plugin-suppress-console-errors',
    enforce: 'pre',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          children: `(function(){
            try {
              // React Fast Refresh preamble
              window.$RefreshReg$ = function() {};
              window.$RefreshSig$ = function() { return function(type) { return type; }; };
              window.__vite_plugin_react_preamble_installed__ = true;

              // 1. Mock Vite HMR WebSocket before @vite/client executes so it never fails
              var RealWebSocket = window.WebSocket;
              if (typeof RealWebSocket === 'function' && !window.__VITE_HMR_WS_MOCKED__) {
                window.__VITE_HMR_WS_MOCKED__ = true;
                function MockHmrSocket(url, protocols) {
                  var urlStr = String(url || '');
                  // If it's the game WebSocket (/ws), let it connect via real WebSocket
                  if (urlStr.indexOf('/ws') !== -1 && protocols !== 'vite-hmr' && protocols !== 'vite-ping') {
                    return new RealWebSocket(url, protocols);
                  }
                  // Otherwise mock the Vite dev HMR socket
                  var target = new EventTarget();
                  var dummy = {
                    url: urlStr,
                    readyState: 1, // OPEN
                    bufferedAmount: 0,
                    extensions: '',
                    protocol: typeof protocols === 'string' ? protocols : 'vite-hmr',
                    binaryType: 'blob',
                    CONNECTING: 0,
                    OPEN: 1,
                    CLOSING: 2,
                    CLOSED: 3,
                    send: function() {},
                    close: function() {},
                    addEventListener: function(type, listener, options) {
                      target.addEventListener(type, listener, options);
                    },
                    removeEventListener: function(type, listener, options) {
                      target.removeEventListener(type, listener, options);
                    },
                    dispatchEvent: function(event) {
                      return target.dispatchEvent(event);
                    },
                    onopen: null,
                    onmessage: null,
                    onerror: null,
                    onclose: null,
                  };
                  setTimeout(function() {
                    var ev = new Event('open');
                    if (typeof dummy.onopen === 'function') dummy.onopen(ev);
                    dummy.dispatchEvent(ev);
                  }, 0);
                  return dummy;
                }
                MockHmrSocket.prototype = RealWebSocket.prototype;
                MockHmrSocket.CONNECTING = RealWebSocket.CONNECTING;
                MockHmrSocket.OPEN = RealWebSocket.OPEN;
                MockHmrSocket.CLOSING = RealWebSocket.CLOSING;
                MockHmrSocket.CLOSED = RealWebSocket.CLOSED;
                window.WebSocket = MockHmrSocket;
              }

              // 2. Suppress Vite HMR logs and errors from console
              var isViteLog = function(args) {
                if (!args || !args.length) return false;
                for (var i = 0; i < args.length; i++) {
                  var a = args[i];
                  var str = typeof a === 'string' ? a : (a && (a.message || a.stack || a.reason) ? (a.message || a.stack || a.reason) : String(a));
                  if (str && (
                    str.indexOf('[vite]') !== -1 ||
                    str.indexOf('vite-hmr') !== -1 ||
                    str.indexOf('[hmr]') !== -1 ||
                    str.indexOf('WebSocket closed without opened') !== -1 ||
                    str.indexOf('@vite/client') !== -1 ||
                    str.indexOf('failed to connect to websocket') !== -1
                  )) return true;
                }
                return false;
              };
              ['error', 'warn', 'log', 'info', 'debug'].forEach(function(m) {
                var orig = console[m];
                if (orig) {
                  console[m] = function() {
                    if (isViteLog(arguments)) return;
                    return orig.apply(console, arguments);
                  };
                }
              });

              // 3. Catch and suppress window error events from Vite HMR
              window.addEventListener('error', function(e) {
                var msg = e ? (e.message || (e.error && e.error.message) || '') : '';
                var stack = e && e.error && e.error.stack ? String(e.error.stack) : '';
                var full = (msg + ' ' + stack);
                if (full && (
                  full.indexOf('[vite]') !== -1 ||
                  full.indexOf('vite-hmr') !== -1 ||
                  full.indexOf('WebSocket closed without opened') !== -1 ||
                  full.indexOf('@vite/client') !== -1 ||
                  full.indexOf('failed to connect to websocket') !== -1
                )) {
                  e.stopImmediatePropagation && e.stopImmediatePropagation();
                  e.stopPropagation && e.stopPropagation();
                  e.preventDefault && e.preventDefault();
                  return true;
                }
              }, true);

              // 4. Catch and suppress unhandledrejection events from Vite HMR
              window.addEventListener('unhandledrejection', function(e) {
                var r = e ? (e.reason || e.message || '') : '';
                var msg = typeof r === 'object' ? (r.message || '') + ' ' + (r.stack || '') : String(r);
                if (msg && (
                  msg.indexOf('[vite]') !== -1 ||
                  msg.indexOf('vite-hmr') !== -1 ||
                  msg.indexOf('WebSocket closed without opened') !== -1 ||
                  msg.indexOf('@vite/client') !== -1 ||
                  msg.indexOf('failed to connect to websocket') !== -1
                )) {
                  e.stopImmediatePropagation && e.stopImmediatePropagation();
                  e.stopPropagation && e.stopPropagation();
                  e.preventDefault && e.preventDefault();
                  return true;
                }
              }, true);

              // 5. Intercept window.onerror as fallback
              var prevOnError = window.onerror;
              window.onerror = function(msg, source, lineno, colno, error) {
                var str = String(msg || '') + ' ' + String(source || '') + ' ' + (error && error.stack ? error.stack : '');
                if (
                  str.indexOf('[vite]') !== -1 ||
                  str.indexOf('vite-hmr') !== -1 ||
                  str.indexOf('WebSocket closed without opened') !== -1 ||
                  str.indexOf('@vite/client') !== -1 ||
                  str.indexOf('failed to connect to websocket') !== -1
                ) {
                  return true;
                }
                if (typeof prevOnError === 'function') {
                  return prevOnError(msg, source, lineno, colno, error);
                }
                return false;
              };
            } catch(e) {}
          })();`,
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      suppressViteConsolePlugin(),
      react(),
      tailwindcss(),
      aistudioMediaPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'favicon.ico',
          'favicon-32x32.png',
          'apple-touch-icon.png',
          'icon-192.png',
          'icon-512.png',
          'logo-du-jeu.png',
          'publisher-logo.png',
          'og-banner.png',
        ],
        manifest: false, // public/manifest.json is already linked in index.html
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,jpg,jpeg,woff,woff2}'],
          globIgnores: ['**/assets/aistudio/**', '**/*.map', '**/Screen_Recording*'],
          navigateFallback: '/index.html',
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MB max for cacheable assets
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: false,
      watch: null,
    },
  };
});
