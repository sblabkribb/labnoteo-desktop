/**
 * 지금 누를 수 없는 단추: `disabled` 대신 `aria-disabled` 로 끈다. 누르자마자 `disabled` 가 된 단추는 키보드 초점을 본문으로
 * 떨구어 Esc·Tab 이 창에 닿지 않고 긴 목록에서 자리를 잃는다(Task 22 실앱 점검). 꺼진 동안 누르면 아무 일도 하지 않는다.
 * 설정 창(어시스턴트 쪽)과 GitHub 미리보기가 함께 쓴다.
 */
export function softOff(off: boolean, run: () => void) {
  return {
    'aria-disabled': off || undefined,
    onClick: () => {
      if (!off) run();
    },
  };
}
