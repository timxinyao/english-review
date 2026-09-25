import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setupAutoUpdate } from './lib/pwa-update';
import { Providers } from './app/providers';
import './styles/globals.css';

setupAutoUpdate();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
