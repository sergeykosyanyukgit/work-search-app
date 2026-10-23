!macro customInstall
  IfFileExists "$INSTDIR\resources\vcredist\vc_redist.x64.exe" 0 runtimeMissing
  ExecWait '"$INSTDIR\resources\vcredist\vc_redist.x64.exe" /install /quiet /norestart' $0
  StrCmp $0 "0" runtimeReady
  StrCmp $0 "1638" runtimeReady
  StrCmp $0 "3010" runtimeReady
  MessageBox MB_OK|MB_ICONSTOP "Не удалось установить Microsoft Visual C++ Runtime ($0). Установка Work Search не завершена."
  SetErrorLevel 1
  Abort
  runtimeMissing:
  MessageBox MB_OK|MB_ICONSTOP "В установщике отсутствует Microsoft Visual C++ Runtime. Установка Work Search не завершена."
  SetErrorLevel 1
  Abort
  runtimeReady:
!macroend
