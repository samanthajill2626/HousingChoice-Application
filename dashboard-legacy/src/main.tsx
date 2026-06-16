import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { registerServiceWorker } from './push/index.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker for Web Push (M1.4). Guarded: only where service
// workers actually run — secure contexts (prod over https) and localhost (dev).
// On http://<ip> dev or unsupported browsers this is a no-op. Push itself only
// activates once VAPID is configured server-side; the SW registering early just
// has it ready.
if (typeof window !== 'undefined' && window.isSecureContext) {
  window.addEventListener('load', () => {
    void registerServiceWorker();
  });
}
