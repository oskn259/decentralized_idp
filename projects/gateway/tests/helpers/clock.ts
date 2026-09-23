import { Clock } from "../../src/domain/infra/clock.js";

/** A `Clock` fixed at the second a test chooses. */
export class TestClock implements Clock {
  constructor(private readonly seconds: number = Math.floor(Date.now() / 1000)) {}

  nowSeconds(): number {
    return this.seconds;
  }
}
