; Inno Setup script: builds winapp\out\Harmonia-Setup-x64.exe from winapp\dist (run winapp\build.ps1 first).
; Compile:  ISCC.exe winapp\installer.iss   (or /DAppVersion=1.2.3)
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6B0F7C1E-4D5A-4C58-9C0E-4A1C8D1E7A21}
AppName=Harmonia
AppVersion={#AppVersion}
AppPublisher=Harmonia
DefaultDirName={localappdata}\Programs\Harmonia
DefaultGroupName=Harmonia
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=assets\harmonia.ico
UninstallDisplayIcon={app}\Harmonia.exe
UninstallDisplayName=Harmonia
OutputDir=out
OutputBaseFilename=Harmonia-Setup-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=force
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Harmonia
MinVersion=10.0

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start Harmonia when I sign in to Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "dist\Harmonia.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\harmonia-server.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\build.json"; DestDir: "{app}"; Flags: ignoreversion
; The starter teammates (as install.sh adds them on a Mac): never over a file that's there, and kept on uninstall.
Source: "..\agents\*.md"; Excludes: "README.md"; DestDir: "{%USERPROFILE}\.claude\agents"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{autoprograms}\Harmonia"; Filename: "{app}\Harmonia.exe"
Name: "{autodesktop}\Harmonia"; Filename: "{app}\Harmonia.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Harmonia"; ValueData: """{app}\Harmonia.exe"""; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\Harmonia.exe"; Description: "Launch Harmonia"; Flags: nowait postinstall skipifsilent

[InstallDelete]
; Leftovers of an in-app update (updates.ts renames the files it replaces to <name>.old).
Type: files; Name: "{app}\*.old"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM Harmonia.exe"; Flags: runhidden; RunOnceId: "KillApp"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM harmonia-server.exe"; Flags: runhidden; RunOnceId: "KillServer"

[Code]
// Harmonia keeps running in the tray when its window is closed, so setup closes it (and its server) before replacing files.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Harmonia.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM harmonia-server.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;

// Harmonia's data (%APPDATA%\Harmonia) and window settings (%LOCALAPPDATA%\Harmonia) are left in place on uninstall,
// unless the user opts to remove them.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if MsgBox('Also delete your Harmonia data (chats, settings, teammates)?' + #13#10 + 'Choose No to keep it for a future install.',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{userappdata}\Harmonia'), True, True, True);
      DelTree(ExpandConstant('{localappdata}\Harmonia'), True, True, True);
    end;
end;
