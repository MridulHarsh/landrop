!macro customUnInstall
  ; ── Remove electron-store config data ──
  RMDir /r "$APPDATA\landrop"

  ; ── Remove LANDrop downloads folder ──
  RMDir /r "$PROFILE\Downloads\LANDrop"

  ; ── Remove Windows Firewall rules created by LANDrop ──
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LANDrop App TCP In"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LANDrop App TCP Out"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LANDrop App UDP In"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="LANDrop App UDP Out"'

  ; ── Remove Electron crash dumps and GPU cache ──
  RMDir /r "$APPDATA\LANDrop"
  RMDir /r "$LOCALAPPDATA\landrop-updater"
!macroend
