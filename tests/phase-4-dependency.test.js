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

test("keyless-ready phase 4 commands (spotify, thoitiet, dich) run with empty config", async () => {
  for (const [command, args] of [
    ["spotify", ["sample"]],
    ["thoitiet", []],
    ["thoitiet", ["Hanoi"]],
    ["dich", ["hello"]],
  ]) {
    const result = await dispatch(command, { args, config: {} }, async () => `handled:${command}`);
    assert.equal(result.code, "HANDLED", command);
    assert.equal(result.value, `handled:${command}`);
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

test("weather accepts OpenWeather, WeatherAPI, or keyless Open-Meteo configuration", async () => {
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
