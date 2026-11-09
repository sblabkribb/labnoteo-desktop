import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/tree.css';
import './styles/menus.css';
import './styles/dialogs.css';
import './styles/viewers.css';
import { installFileDropGuard } from './ui/fileDropGuard';

// 창의 dragDropEnabled 가 꺼져 있다(이미지 끌어 놓기): 편집기 밖에 놓은 OS 파일이 웹뷰를 file:// 로 옮기지 않게 막는다.
installFileDropGuard(window);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
