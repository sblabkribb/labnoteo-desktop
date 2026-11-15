import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyHtmlLang, getLang } from '../i18n/lang';
import { PetApp } from './PetApp';
import { tauriPetIpc } from './petIpc';
import '../styles/tokens.css';
import '../styles/pet.css';

// localStorage is shared with the main window (one origin): the language and theme it stored apply here too.
applyHtmlLang(getLang());
createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <PetApp ipc={tauriPetIpc} />
  </React.StrictMode>,
);
