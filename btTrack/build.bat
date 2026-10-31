@echo off
setlocal enabledelayedexpansion

set SDK=C:\Users\user\AppData\Local\Android\Sdk
set BT=%SDK%\build-tools\30.0.3
set PLATFORM=%SDK%\platforms\android-33\android.jar
set ROOT=D:\Github\btTrack
set JDK=C:\Program Files\Java\jdk1.8.0_333\bin
set SRC=%ROOT%\app\src\main
set OUT=%ROOT%\build
set CLASSES=%OUT%\classes
set GEN=%OUT%\gen

if exist %OUT% rmdir /s /q %OUT%
mkdir %CLASSES% %GEN% %OUT%\res_flat

echo [1/6] aapt2 compile resources
%BT%\aapt2.exe compile --dir %SRC%\res -o %OUT%\res_flat.zip || goto :fail

echo [2/6] aapt2 link
%BT%\aapt2.exe link -o %OUT%\bttrack-unsigned.apk -I %PLATFORM% ^
  --manifest %SRC%\AndroidManifest.xml ^
  --java %GEN% ^
  --min-sdk-version 21 --target-sdk-version 33 ^
  %OUT%\res_flat.zip || goto :fail

echo [3/6] javac
dir /s /b %SRC%\java\*.java > %OUT%\sources.txt
for %%f in (%GEN%\com\bttrack\app\R.java) do echo %%f >> %OUT%\sources.txt
"%JDK%\javac.exe" -encoding UTF-8 -source 1.8 -target 1.8 -bootclasspath %PLATFORM% -d %CLASSES% @%OUT%\sources.txt || goto :fail

echo [4/6] d8 dex
call %BT%\d8.bat --release --min-api 21 --lib %PLATFORM% --output %OUT% %CLASSES%\com\bttrack\app\*.class || goto :fail

echo [5/6] add dex + zipalign
copy /y %OUT%\bttrack-unsigned.apk %OUT%\bttrack-dex.apk >nul
cd /d %OUT%
"%JDK%\jar.exe" uf bttrack-dex.apk classes.dex
cd /d %ROOT%
%BT%\zipalign.exe -f -p 4 %OUT%\bttrack-dex.apk %OUT%\bttrack-aligned.apk || goto :fail

echo [6/6] sign
if not exist %OUT%\debug.keystore (
  "%JDK%\keytool.exe" -genkeypair -v -keystore %OUT%\debug.keystore -alias bttrack ^
    -keyalg RSA -keysize 2048 -validity 10000 ^
    -storepass android -keypass android ^
    -dname "CN=btTrack, OU=dev, O=dev, L=dev, S=dev, C=TW" || goto :fail
)
call %BT%\apksigner.bat sign --ks %OUT%\debug.keystore --ks-pass pass:android --key-pass pass:android ^
  --out %OUT%\btTrack.apk %OUT%\bttrack-aligned.apk || goto :fail

echo.
echo === BUILD OK: %OUT%\btTrack.apk ===
exit /b 0

:fail
echo.
echo === BUILD FAILED (step above) ===
exit /b 1
