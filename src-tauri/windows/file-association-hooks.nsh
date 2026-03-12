!macro NSIS_HOOK_POSTINSTALL
  ; 只覆写 FlyMD 自己的 ProgID，避免去碰系统通用类型名
  WriteRegStr SHCTX "Software\Classes\flymd.markdown\DefaultIcon" "" '$\"$INSTDIR\resources\file-association.ico$\"'
  WriteRegStr SHCTX "Software\Classes\flymd.pdf\DefaultIcon" "" '$\"$INSTDIR\resources\file-association.ico$\"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 兜底清理我们补写的默认图标键，防止卸载后残留
  DeleteRegKey SHCTX "Software\Classes\flymd.markdown\DefaultIcon"
  DeleteRegKey SHCTX "Software\Classes\flymd.pdf\DefaultIcon"
!macroend
