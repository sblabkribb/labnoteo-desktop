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
import { layoutStore } from './ui/layoutStore';

// 창의 dragDropEnabled 가 꺼져 있다(이미지 끌어 놓기): 편집기 밖에 놓은 OS 파일이 웹뷰를 file:// 로 옮기지 않게 막는다.
installFileDropGuard(window);

// 창은 숨긴 채 뜬다: Rust ui.json 의 배치를 그리기 전에 읽기 시작하고, useTheme 은 이것이 끝난 뒤에 창을 보인다.
void layoutStore.load();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
