// Loaded before every test file (see package.json). Tests never touch the real Keychain/DPAPI;
// the Keychain test targets its own throwaway service explicitly.
process.env.SLOPBOT_SECRETS = "file";
