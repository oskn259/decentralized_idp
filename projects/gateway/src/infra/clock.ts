import { Clock } from "../domain/infra/clock.js";

export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};
