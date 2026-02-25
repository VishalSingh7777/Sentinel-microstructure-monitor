import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Tailwind processed at build time via PostCSS — must be first import
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('[Sentinel] Fatal: could not find #root element to mount React tree.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
