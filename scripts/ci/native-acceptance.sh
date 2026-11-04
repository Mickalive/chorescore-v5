#!/usr/bin/env bash
# Disposable GitHub runner only; no user device or production data is touched.
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test -c /dev/kvm
sudo chmod a+rw /dev/kvm
export ANDROID_AVD_HOME="$RUNNER_TEMP/chorescore-avd"
mkdir -p "$ANDROID_AVD_HOME" verification-evidence/android
sdk_root=${ANDROID_HOME:?Android SDK must be installed on the runner}
export PATH="$sdk_root/platform-tools:$sdk_root/emulator:$PATH"
sdk_manager=$(find "$sdk_root/cmdline-tools" -maxdepth 3 -type f -name sdkmanager | sort -V | tail -1)
test -n "$sdk_manager" && test -x "$sdk_manager"
export PATH="$(dirname "$sdk_manager"):$PATH"
if ! test -f "$ANDROID_AVD_HOME/chorescore-ci.ini"; then
  sdkmanager 'system-images;android-35;default;x86_64' 'emulator' 'platform-tools'
  echo no | avdmanager create avd --name chorescore-ci --package 'system-images;android-35;default;x86_64' --device pixel_2
fi
npx --no-install expo prebuild --platform android --no-install --clean
pushd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64 --max-workers=2 --no-daemon --build-cache
popd
apk=android/app/build/outputs/apk/release/app-release.apk
bash scripts/android/verify-apk-identity.sh "$apk" > verification-evidence/android/identity.txt 2>&1
emulator -avd chorescore-ci -no-window -no-audio -no-boot-anim -gpu swiftshader \
  -accel on -no-snapshot -camera-back none -camera-front none \
  > verification-evidence/android/emulator.log 2>&1 &
emulator_pid=$!
trap 'adb emu kill >/dev/null 2>&1 || true; kill "$emulator_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in $(seq 1 90); do
  # Historical V4 lesson: boot_completed alone does not establish live PM/input.
  if timeout 10 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -qx 1 && \
     timeout 10 adb shell pm path android 2>/dev/null | grep -q '^package:' && \
     timeout 10 adb shell input keyevent 0 >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
test "$ready" = true
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell wm dismiss-keyguard
export ANDROID_EVIDENCE_DIR=verification-evidence/android
export ANDROID_TEST_GROUP_NAME="MaisonCI${GITHUB_RUN_ID}${AUTOPILOT_ATTEMPT:-0}"
python3 scripts/android/run-journey.py "$apk"
