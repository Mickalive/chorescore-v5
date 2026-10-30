#!/usr/bin/env bash
# Verify the built artifact independently of Firebase credentials:
# - exact Android package identity,
# - a single signer,
# - the signing certificate fingerprints Firebase must trust.
# Nothing here fabricates a Firebase project, key or OAuth client.
set -euo pipefail

APK=${1:?usage: verify-apk-identity.sh <apk>}
PACKAGE=${ANDROID_PACKAGE:-app.chorescore.v5}
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -z "$SDK" ] || [ ! -d "$SDK/build-tools" ]; then
  echo "ANDROID_HOME/ANDROID_SDK_ROOT with build-tools is required" >&2
  exit 1
fi

BUILD_TOOLS=$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
AAPT="$BUILD_TOOLS/aapt"
APKSIGNER="$BUILD_TOOLS/apksigner"
for tool in "$AAPT" "$APKSIGNER"; do
  [ -x "$tool" ] || { echo "Missing Android build tool: $tool" >&2; exit 1; }
done

BADGING=$("$AAPT" dump badging "$APK")
ACTUAL=$(
  printf '%s\n' "$BADGING" |
    sed -n "s/^package: name='\([^']*\)'.*/\1/p" |
    head -1
)
if [ "$ACTUAL" != "$PACKAGE" ]; then
  echo "APK package mismatch: expected $PACKAGE, got ${ACTUAL:-unknown}" >&2
  exit 1
fi
if printf '%s\n' "$BADGING" | grep -q '^application-debuggable'; then
  echo "Release artifact is debuggable; refusing to treat it as a release candidate" >&2
  exit 1
fi

CERTS=$("$APKSIGNER" verify --verbose --print-certs "$APK")
SIGNERS=$(printf '%s\n' "$CERTS" | grep -c '^Signer #1 certificate SHA-1 digest:' || true)
if [ "$SIGNERS" -ne 1 ]; then
  echo "Expected exactly one APK signer, found $SIGNERS" >&2
  exit 1
fi
SHA1=$(printf '%s\n' "$CERTS" | sed -n 's/^Signer #1 certificate SHA-1 digest: //p' | head -1)
SHA256=$(printf '%s\n' "$CERTS" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -1)

if [ -n "${ANDROID_EXPECTED_SHA1:-}" ]; then
  EXPECTED=$(printf '%s' "$ANDROID_EXPECTED_SHA1" | tr '[:lower:]' '[:upper:]')
  ACTUAL_SHA1=$(printf '%s' "$SHA1" | tr '[:lower:]' '[:upper:]')
  if [ "$EXPECTED" != "$ACTUAL_SHA1" ]; then
    echo "APK signing SHA-1 mismatch: expected $EXPECTED, got $ACTUAL_SHA1" >&2
    exit 1
  fi
fi

VERSION_NAME=$(printf '%s\n' "$BADGING" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" | head -1)
VERSION_CODE=$(printf '%s\n' "$BADGING" | sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" | head -1)

printf 'package=%s\n' "$ACTUAL"
printf 'versionName=%s\n' "$VERSION_NAME"
printf 'versionCode=%s\n' "$VERSION_CODE"
printf 'signer_sha1=%s\n' "$SHA1"
printf 'signer_sha256=%s\n' "$SHA256"
printf 'Add %s (SHA-1) to the Firebase Android app %s after confirming the same signing key is used for the candidate.\n' "$SHA1" "$ACTUAL"
