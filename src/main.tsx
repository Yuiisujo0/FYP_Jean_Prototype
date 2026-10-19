import '@fontsource-variable/familjen-grotesk';
import '@fontsource-variable/caveat';
import '@fontsource-variable/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/FYP_Jean_Prototype">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
