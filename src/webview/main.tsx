import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { GROUP_HEADER_HEIGHT, ROW_HEIGHT } from './format.js';
import './theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Panorama webview: #root is missing from the host HTML');
}

// The virtualizer positions rows by these numbers, so the stylesheet has to
// agree with them exactly — publishing them here keeps one definition.
document.documentElement.style.setProperty(
  '--panorama-row-height',
  `${ROW_HEIGHT}px`,
);
document.documentElement.style.setProperty(
  '--panorama-group-height',
  `${GROUP_HEADER_HEIGHT}px`,
);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
