import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Panorama webview: #root is missing from the host HTML');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
