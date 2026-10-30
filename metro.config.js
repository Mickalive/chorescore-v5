const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// expo-sqlite's real web driver loads its WASM asset in a worker.
config.resolver.assetExts.push('wasm');
module.exports = config;
