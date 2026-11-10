const { withAppBuildGradle } = require('expo/config-plugins');

const PINNED_NDK_VERSION = '27.3.13750724';

module.exports = function withPinnedAndroidNdk(config) {
  return withAppBuildGradle(config, (result) => {
    if (result.modResults.language !== 'groovy') {
      throw new Error('withPinnedAndroidNdk expects a Groovy android/app/build.gradle');
    }
    const { contents } = result.modResults;
    const patched = contents.replace(
      /ndkVersion\s+rootProject\.ext\.ndkVersion/,
      `ndkVersion "${PINNED_NDK_VERSION}"`,
    );
    if (patched === contents) {
      throw new Error('withPinnedAndroidNdk could not find the Expo NDK line in android/app/build.gradle');
    }
    result.modResults.contents = patched;
    return result;
  });
};
