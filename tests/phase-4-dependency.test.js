import test from "node:test";
import assert from "node:assert/strict";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { createPhase4Registry } from "../src/commands/command-registry.js";

const dispatch = (command, context = {}, handler = async () => "ok") => dispatchCommand({
  commandParts: [...command.split(" "), ...(context.args ?? [])],
  scope: "group",
  permissionLevel: "all",
  api: {},
  message: {},
  dependencies: {
    zaloSession: true,
    python: true,
    ffmpeg: true,
    ffprobe: true,
  },
  ...context,
}, createPhase4Registry({ [command]: handler }));

test("provider-backed phase 4 commands report missing configuration", async () => {
  const cases = [
    ["spotify", "SPOTIFY_CLIENT_ID", ["sample"]],
    ["spotify", "SPOTIFY_CLIENT_SECRET", ["sample"]],
    ["spotify", "SPOTIFY_DOWNLOADER_SECRET", ["sample"]],
    ["spotify", "SPOTIFY_DOWNLOADER_PASSPHRASE", ["sample"]],
    ["thoitiet", "OPENWEATHER_API_KEY", ["sample"]],
  ];

  for (const [command, missing, args] of cases) {
    const config = {
      HOANGDEV_API_KEY: "test-hoangdev",
      TIKTOK_SEARCH_API_URL: "https://tiktok.example.test/search",
      TIKTOK_SEARCH_API_KEY: "test-tiktok",
      SPOTIFY_CLIENT_ID: "test-client",
      SPOTIFY_CLIENT_SECRET: "test-secret",
      OPENWEATHER_API_KEY: "test-weather",
    };
    delete config[missing];
    const result = await dispatch(command, { args, config });
    assert.equal(result.code, "MISSING_DEPENDENCY", `${command}:${missing}`);
    const missingKeys = result.missing.flatMap((requirement) => (
      Array.isArray(requirement) ? requirement : [requirement]
    ));
    assert.ok(missingKeys.includes(missing), `${command}:${missing}`);
  }
});

test("a configured provider reaches the injected handler without a network call", async () => {
  let invoked = false;
  const result = await dispatch("tiktok", {
    args: ["sample"],
    config: {
      TIKTOK_SEARCH_API_URL: "https://tiktok.example.test/search",
      TIKTOK_SEARCH_API_KEY: "test-tiktok",
    },
  }, async () => {
    invoked = true;
    return "mocked";
  });

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "mocked");
  assert.equal(invoked, true);
});

test("weather accepts either supported provider configuration", async () => {
  const withOpenWeather = await dispatch("thoitiet", {
    args: ["Bangkok"],
    config: { OPENWEATHER_API_KEY: "test-openweather" },
  }, async () => "mocked-openweather");
  assert.equal(withOpenWeather.code, "HANDLED");

  const result = await dispatch("thoitiet", {
    args: ["Bangkok"],
    config: { WEATHERAPI_KEY: "test-weatherapi" },
  }, async () => "mocked-weather");

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "mocked-weather");
});
