; PC Full Control - extra installer steps (included by electron-builder).

!macro customInstall
  ; Autostart at logon with highest privileges via Task Scheduler,
  ; so the app can shut down the PC and install Windows/winget updates without a UAC prompt.
  nsExec::ExecToLog 'schtasks /Create /F /TN "PCFullControl" /SC ONLOGON /RL HIGHEST /IT /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\" --hidden"'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'schtasks /Delete /F /TN "PCFullControl"'
!macroend
