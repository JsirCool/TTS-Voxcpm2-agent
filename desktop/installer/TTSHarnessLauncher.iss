#define MyAppName "姜Sir TTS 工作台"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "JsirCool"
#define MyAppExeName "TTSHarnessLauncher.exe"

#ifndef PortableDir
  #define PortableDir "..\portable"
#endif

#ifndef AssetsDir
  #define AssetsDir "..\assets"
#endif

#ifndef LicensePath
  #define LicensePath "..\..\LICENSE"
#endif

#ifndef InstallerOutputDir
  #define InstallerOutputDir "dist"
#endif

[Setup]
AppId={{8D8F4897-32F4-4493-9865-E45531E91C62}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\TTSHarnessLauncher
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupIconFile={#AssetsDir}\launcher-icon.ico
WizardImageFile={#AssetsDir}\installer-wizard.bmp
WizardSmallImageFile={#AssetsDir}\installer-small.bmp
LicenseFile={#LicensePath}
OutputDir={#InstallerOutputDir}
OutputBaseFilename=tts-agent-harness-setup-v{#MyAppVersion}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: unchecked

[Files]
Source: "{#PortableDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\launcher-icon.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\assets\launcher-icon.ico"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent
