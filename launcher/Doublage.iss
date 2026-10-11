; Installateur Windows de Doublage (Inno Setup 6)
#define AppVersion GetEnv("DOUBLAGE_VERSION")
#if AppVersion == ""
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6F1D3C2A-8B47-4E8B-9C1D-D0B1A6E5F201}
AppName=Doublage
AppVersion={#AppVersion}
AppPublisher=Doublage
DefaultDirName={localappdata}\Programs\Doublage
DefaultGroupName=Doublage
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Doublage-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\Doublage.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardImageFile=wizard-large-100.bmp,wizard-large.bmp
WizardSmallImageFile=wizard-small-100.bmp,wizard-small.bmp
WizardImageStretch=yes
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer une icône sur le Bureau"; GroupDescription: "Raccourcis :"

[Files]
Source: "..\dist\Doublage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Doublage"; Filename: "{app}\Doublage.exe"
Name: "{group}\Désinstaller Doublage"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Doublage"; Filename: "{app}\Doublage.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Doublage.exe"; Description: "Lancer Doublage"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Le moteur installé au premier lancement (Python, modèles) : plusieurs Go
Type: filesandordirs; Name: "{localappdata}\Doublage\.venv"
Type: filesandordirs; Name: "{localappdata}\Doublage\_model_cache"
