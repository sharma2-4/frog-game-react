import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initPostHog } from './analytics';
import '@fontsource/gloock';
import '@fontsource-variable/jost';

// Initialize PostHog analytics and session replay
initPostHog();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
