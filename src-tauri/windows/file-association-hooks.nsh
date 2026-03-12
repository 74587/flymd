!macro NSIS_HOOK_POSTINSTALL
  ; 用专用图标覆盖关联文件的默认图标，避免回退成程序图标
  WriteRegStr SHCTX "Software\Classes\flymd.md\DefaultIcon" "" '$\"$INSTDIR\resources\file-association.ico$\"'
  WriteRegStr SHCTX "Software\Classes\flymd.markdown\DefaultIcon" "" '$\"$INSTDIR\resources\file-association.ico$\"'
  WriteRegStr SHCTX "Software\Classes\flymd.pdf\DefaultIcon" "" '$\"$INSTDIR\resources\file-association.ico$\"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 兜底清理我们补写的默认图标键，防止卸载后残留
  DeleteRegKey SHCTX "Software\Classes\flymd.md\DefaultIcon"
  DeleteRegKey SHCTX "Software\Classes\flymd.markdown\DefaultIcon"
  DeleteRegKey SHCTX "Software\Classes\flymd.pdf\DefaultIcon"
!macroend
