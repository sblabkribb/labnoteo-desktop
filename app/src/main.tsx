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
import { startModalityTracking } from './ui/interactionModality';
import { layoutStore } from './ui/layoutStore';
import { startReducedMotionMirror } from './ui/reducedMotion';

// 창의 dragDropEnabled 가 꺼져 있다(이미지 끌어 놓기): 편집기 밖에 놓은 OS 파일이 웹뷰를 file:// 로 옮기지 않게 막는다.
installFileDropGuard(window);

// 키보드·포인터 중 무엇으로 일하는지 기억한다: 돌려준 초점의 고리는 키보드로 일할 때만 보인다(returnFocus.ts).
startModalityTracking();

// 운영체제의 줄인 움직임 설정을 <html data-reduced-motion> 으로 비춘다(토큰이 움직임 길이를 0 으로 만들고, 스크립트는 속성을 읽는다).
startReducedMotionMirror();

// 창은 숨긴 채 뜬다: Rust ui.json 의 배치를 그리기 전에 읽기 시작하고, useTheme 은 이것이 끝난 뒤에 창을 보인다.
void layoutStore.load();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
