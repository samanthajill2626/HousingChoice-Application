// Bootstrap — mount the React root inside a BrowserRouter. The router config
// (auth gate + AppFrame + routes) lives in App.tsx.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
import { ImageViewerProvider } from './ui/imageViewer/ImageViewerProvider.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ImageViewerProvider>
        <App />
      </ImageViewerProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Service worker (public/sw.js) - PUSH only, no precaching. Registering it is
// what makes the app installable AND is the precondition for web push at all:
// useNotifications awaits `navigator.serviceWorker.ready`, which never resolves
// when nothing is registered. Restored 2026-08-15 after the worker was deleted
// with the dashboard-legacy workspace.
//
// Registered AFTER render so it never delays first paint, and only on a secure
// context (https or localhost) because `navigator.serviceWorker` is undefined
// otherwise - which is also why this is feature-detected rather than assumed.
// Failure is logged and swallowed: the dashboard is fully usable without push.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.error('service worker registration failed - push will be unavailable', err);
    });
  });
}
