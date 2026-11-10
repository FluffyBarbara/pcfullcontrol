; PC Full Control - extra installer steps (included by electron-builder).

!macro customInstall
  ; Autostart at logon with highest privileges via Task Scheduler,
  ; so the app can shut down the PC and install Windows/winget updates without a UAC prompt.
  nsExec::ExecToLog 'schtasks /Create /F /TN "PCFullControl" /SC ONLOGON /RL HIGHEST /IT /TR "\"$INSTDIR\${APP_EXECUTABLE_FILENAME}\" --hidden"'
  ; Allow the phone app to reach the built-in server over Wi-Fi (only paired phones get access).
  ; remoteip=localsubnet: only devices from the same local network, never from the internet.
  ; profile=any: Windows often marks home Wi-Fi as "public" by default; the app itself only admits
  ; devices from the same home subnet (NetGuard) and pairing needs the code shown on this PC.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PC Full Control"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PC Full Control" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any remoteip=localsubnet'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'schtasks /Delete /F /TN "PCFullControl"'
  ; Compiled helper cache next to the program (created by the app itself)
  RMDir /r "$INSTDIR\cache"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PC Full Control"'
!macroend
